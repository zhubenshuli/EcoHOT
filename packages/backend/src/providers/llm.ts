// OpenAI-compatible chat calls, always through receipts. One model is enough: `default` is whatever the
// deployment names in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, and every capability uses it unless the
// site, an environment variable or the admin's model page picks one of the site's named presets
// (site/models.ts).
import type { z } from "zod";
import type { ModelPreset } from "@aihot/contracts/site-config";
import { PRESETS } from "@aihot/site/models";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import {
  assertAccepted, failureKind, logicalKeyFor, ModelOutputError, ModelUnavailableError, paidRequest, ProviderRejectedError, receiptState, rejectReceivedResponse,
  type ReceiptRequest,
} from "./receipts.ts";
import { enterModelCircuit, recordModelHealth, type CircuitPermit } from "./circuit.ts";

export interface ModelSpec extends ModelPreset {
  key: string;
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

function reasoningTokensFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("LLM_REASONING_TOKENS must be a non-negative integer, e.g. 4000");
  return Number(value);
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get reasoningTokens() { return reasoningTokensFromEnv(process.env.LLM_REASONING_TOKENS); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // The pack's named presets, each with its own address and key.
  ...Object.fromEntries(Object.entries(PRESETS).map(([key, preset]) => [key, { key, ...preset }])),
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  /** One independently operated, evaluated backup. Only availability failures switch providers. */
  fallbackModel?: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

function requestFor<S extends z.ZodType>(opts: ChatJsonOptions<S>, spec: ModelSpec) {
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.reasoningTokens ?? 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const request: ReceiptRequest = {
    service: spec.service, model: spec.model, purpose: opts.purpose, subject: opts.subject,
    identity: { model: spec.model, promptVersion: opts.promptVersion, system: sha256(opts.system || ""), user: sha256(userText), temperature, maxTokens, extra: spec.extra ?? null },
    requestSummary: { promptVersion: opts.promptVersion, systemHash: sha256(opts.system || ""), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens },
    attemptTag: opts.attemptTag,
  };
  return { request, temperature, maxTokens, userText };
}

/** A call without a backup waits this long for its answer. */
const TIMEOUT_MS = 120_000;
/**
 * A call with an evaluated backup gives up sooner: the backup takes over at once, and the primary's
 * receipt stays unknown (it may be billed as well). On the steps that have a backup, 6 of about 14,000
 * answers took longer than this (99.9% came within it, the slowest in 77 s), while in an outage every
 * call held its work for the full wait before failing.
 */
const FAILOVER_TIMEOUT_MS = 30_000;

/**
 * With a backup (fallbackModel: editorial/models.ts picks one at another provider), a primary whose
 * outcome is unknown, or that the provider turns away for now, is continued by the backup at once:
 * besides the one release in operations/recover.ts, the other place where an unknown outcome is
 * followed by a second paid request.
 */
export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  if (!opts.fallbackModel) return chatOnce(opts);
  const backupOpts = { ...opts, model: opts.fallbackModel };
  const fallbackFor = logicalKeyFor(requestFor(opts, MODELS[opts.model]!).request);
  const saved = await receiptState(requestFor(backupOpts, MODELS[opts.fallbackModel]!).request);
  // Finish an existing backup attempt before choosing a provider again, even after recovery/restart.
  if (saved && saved !== "failed") return chatOnce(backupOpts, true, fallbackFor);
  try {
    return await chatOnce(opts, true);
  } catch (error) {
    const kind = failureKind(error);
    if (kind !== "unknown" && kind !== "outage") throw error;
    return chatOnce(backupOpts, true, fallbackFor);
  }
}

/**
 * 根据环境变量配置的 RPM（每分钟请求数）计算最小请求间隔毫秒数。
 * 默认 RPM = 5（即每 12 秒最多 1 次，12,000 毫秒）。
 * 若配置 LLM_RPM=0，则不设固定最小间隔（但仍执行单任务串行排队）。
 */
export function getLlmIntervalMs(): number {
  const rpmStr = process.env.LLM_RPM;
  if (rpmStr !== undefined && rpmStr !== "") {
    const rpm = Number(rpmStr);
    if (Number.isNaN(rpm) || rpm <= 0) return 0;
    return Math.round(60_000 / rpm);
  }
  return 12_000; // 默认每 12 秒最多 1 次 (RPM = 5)
}

interface ThrottleState {
  lastRequestTime: number;
  chain: Promise<void>;
}

const serviceThrottleQueues = new Map<string, ThrottleState>();

/**
 * 服务端请求频率限制与单任务串行排队：
 * 保证同一时刻全局/服务只有一个请求在发起和执行，且两次请求发起间隔至少满足 minIntervalMs。
 */
export function throttleService(serviceKey: string, minIntervalMs: number): Promise<void> {
  let state = serviceThrottleQueues.get(serviceKey);
  if (!state) {
    state = { lastRequestTime: 0, chain: Promise.resolve() };
    serviceThrottleQueues.set(serviceKey, state);
  }

  const currentWait = state.chain.then(async () => {
    if (minIntervalMs > 0) {
      const now = Date.now();
      const elapsed = now - state!.lastRequestTime;
      if (elapsed < minIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
      }
    }
    state!.lastRequestTime = Date.now();
  });

  state.chain = currentWait.catch(() => {});
  return currentWait;
}

function recordThrottleBackoff(serviceKey: string) {
  const state = serviceThrottleQueues.get(serviceKey);
  if (state) {
    state.lastRequestTime = Date.now();
  }
}

export const CHANNEL_FAILURE_LIMIT = 3;
export const CHANNEL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export type QuotaMode = "nvidia" | "apinex" | "tokenharbor" | "http-status" | "subscription";

export interface LlmChannelConfig {
  index: number;
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  quotaMode: QuotaMode;
  extra?: Record<string, unknown>;
}

export interface LlmChannelQuotaInfo {
  usedPct?: number | null;
  remainingTokens?: number | null;
  limitTokens?: number | null;
  resetsAt?: string | null;
  updatedAt?: string | null;
}

export interface LlmChannelState {
  consecutiveFailures: number;
  cooldownUntil: number;
  exhaustedUntil: number;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  lastError?: string | null;
  recentFailures?: Array<{ at: string; error: string }>;
  quotaInfo?: LlmChannelQuotaInfo | null;
  resetAt?: number;
  updatedAtMs?: number;
}

export const CHANNEL_STATE_SETTING_KEY = "llm.channels.state";

const channelStates = new Map<string, LlmChannelState>();

function shouldPersistState(): boolean {
  return process.env.AIHOT_CREDENTIALS_DIR !== "/nonexistent-test-credentials";
}

function stateTimestampMs(s?: Partial<LlmChannelState> | null): number {
  if (!s) return 0;
  const lastSuccess = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) || 0 : 0;
  const lastError = s.lastErrorAt ? Date.parse(s.lastErrorAt) || 0 : 0;
  const quotaUpdated = s.quotaInfo?.updatedAt ? Date.parse(s.quotaInfo.updatedAt) || 0 : 0;
  return Math.max(s.updatedAtMs ?? 0, s.resetAt ?? 0, lastSuccess, lastError, quotaUpdated);
}

function schedulePersistChannelState(channelId: string): void {
  if (!shouldPersistState()) return;
  const current = channelStates.get(channelId);
  if (!current) return;
  const patch: Record<string, LlmChannelState> = { [channelId]: { ...current } };
  sql`INSERT INTO settings (key, value, updated_by)
      VALUES (${CHANNEL_STATE_SETTING_KEY}, ${sql.json(patch as never)}, 'llm-pool')
      ON CONFLICT (key) DO UPDATE
      SET value = coalesce(settings.value, '{}'::jsonb) || EXCLUDED.value,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()`
    .catch(() => {});
}

export async function syncChannelStatesFromDb(options?: { force?: boolean }): Promise<Record<string, LlmChannelState>> {
  try {
    const [row] = await sql<{ value: Record<string, LlmChannelState> }[]>`
      SELECT value FROM settings WHERE key = ${CHANNEL_STATE_SETTING_KEY}`;
    const saved = row?.value && typeof row.value === "object" ? row.value : {};
    if (options?.force) {
      channelStates.clear();
    }
    for (const [id, remote] of Object.entries(saved)) {
      if (!remote || typeof remote !== "object") continue;
      const local = channelStates.get(id);
      if (options?.force || !local || stateTimestampMs(remote) >= stateTimestampMs(local)) {
        channelStates.set(id, {
          consecutiveFailures: Number(remote.consecutiveFailures ?? 0),
          cooldownUntil: Number(remote.cooldownUntil ?? 0),
          exhaustedUntil: Number(remote.exhaustedUntil ?? 0),
          lastSuccessAt: remote.lastSuccessAt ?? local?.lastSuccessAt ?? null,
          lastErrorAt: remote.lastErrorAt ?? null,
          lastError: remote.lastError ?? null,
          recentFailures: remote.recentFailures ?? local?.recentFailures ?? [],
          quotaInfo: remote.quotaInfo ?? local?.quotaInfo ?? null,
          resetAt: remote.resetAt ?? 0,
          updatedAtMs: stateTimestampMs(remote),
        });
      }
    }
    return saved;
  } catch {
    return {};
  }
}

export function getChannelState(channelId: string): LlmChannelState {
  let state = channelStates.get(channelId);
  if (!state) {
    state = { consecutiveFailures: 0, cooldownUntil: 0, exhaustedUntil: 0 };
    channelStates.set(channelId, state);
  }
  return state;
}

export function isChannelAvailable(channelId: string, nowMs = Date.now()): boolean {
  const state = getChannelState(channelId);
  if (state.cooldownUntil > 0 && nowMs >= state.cooldownUntil) {
    state.cooldownUntil = 0;
    state.consecutiveFailures = 0;
  }
  return nowMs >= state.exhaustedUntil && nowMs >= state.cooldownUntil;
}

export function resetChannelStates(): void {
  channelStates.clear();
}

export function recordChannelSuccess(channelId: string, nowMs = Date.now()): void {
  const state = getChannelState(channelId);
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.lastSuccessAt = new Date(nowMs).toISOString();
  state.updatedAtMs = nowMs;
  schedulePersistChannelState(channelId);
}

export function recordChannelFailure(channelId: string, nowMs = Date.now(), errorMsg?: string): LlmChannelState {
  const state = getChannelState(channelId);
  state.lastErrorAt = new Date(nowMs).toISOString();
  if (errorMsg) {
    state.lastError = errorMsg.slice(0, 300);
    state.recentFailures ??= [];
    state.recentFailures.unshift({ at: new Date(nowMs).toISOString(), error: errorMsg.slice(0, 300) });
    if (state.recentFailures.length > 20) state.recentFailures.length = 20;
  }
  if (nowMs < state.cooldownUntil) {
    state.consecutiveFailures = CHANNEL_FAILURE_LIMIT;
    state.updatedAtMs = nowMs;
    schedulePersistChannelState(channelId);
    return state;
  }
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= CHANNEL_FAILURE_LIMIT) {
    state.cooldownUntil = nowMs + CHANNEL_COOLDOWN_MS;
    state.consecutiveFailures = CHANNEL_FAILURE_LIMIT;
  }
  state.updatedAtMs = nowMs;
  schedulePersistChannelState(channelId);
  return state;
}

export function markChannelExhausted(channelId: string, untilMs: number, errorMsg?: string, nowMs = Date.now()): LlmChannelState {
  const state = getChannelState(channelId);
  state.exhaustedUntil = untilMs;
  state.consecutiveFailures = 0;
  if (errorMsg) {
    state.lastErrorAt = new Date(nowMs).toISOString();
    state.lastError = errorMsg.slice(0, 300);
    state.recentFailures ??= [];
    state.recentFailures.unshift({ at: new Date(nowMs).toISOString(), error: errorMsg.slice(0, 300) });
    if (state.recentFailures.length > 20) state.recentFailures.length = 20;
  }
  state.updatedAtMs = nowMs;
  schedulePersistChannelState(channelId);
  return state;
}

export function updateChannelQuotaInfo(channelId: string, info: LlmChannelQuotaInfo, nowMs = Date.now()): void {
  const state = getChannelState(channelId);
  state.quotaInfo = { ...state.quotaInfo, ...info, updatedAt: new Date(nowMs).toISOString() };
  state.updatedAtMs = nowMs;
  schedulePersistChannelState(channelId);
}

export function getNextUtcResetMs(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const nextDayOffset = d.getUTCHours() < 1 ? 0 : 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + nextDayOffset, 1, 0, 0, 0);
}

export function getTokenThreshold(): number {
  const val = process.env.LLM_TOKEN_THRESHOLD;
  if (val !== undefined && val !== "") {
    const num = Number(val);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return 50_000;
}

export function detectQuotaMode(baseUrl: string, explicitMode?: string | null): QuotaMode {
  const normalized = explicitMode?.trim().toLowerCase();
  if (
    normalized === "nvidia" ||
    normalized === "apinex" ||
    normalized === "tokenharbor" ||
    normalized === "http-status" ||
    normalized === "subscription"
  ) {
    return normalized;
  }
  const lowerUrl = baseUrl.toLowerCase();
  if (lowerUrl.includes("apinex.bond")) return "apinex";
  if (lowerUrl.includes("tokenharbor.ai")) return "tokenharbor";
  if (lowerUrl.includes("nvidia.com")) return "nvidia";
  return "http-status";
}

export function getLlmChannels(spec: ModelSpec): LlmChannelConfig[] {
  const primaryBaseUrl = credential("models", spec.baseUrlEnv);
  const primaryApiKey = credential("models", spec.apiKeyEnv);
  if (!primaryBaseUrl || !primaryApiKey || !spec.model) return [];

  const channels: LlmChannelConfig[] = [
    {
      index: 1,
      id: "ch-1",
      baseUrl: primaryBaseUrl,
      apiKey: primaryApiKey,
      model: spec.model,
      quotaMode: detectQuotaMode(
        primaryBaseUrl,
        spec.key === "default" ? (process.env.LLM_CHANNEL_1_QUOTA_MODE ?? process.env.LLM_QUOTA_MODE) : undefined,
      ),
      extra: spec.extra,
    },
  ];

  if (spec.key !== "default") return channels;

  for (let i = 2; i <= 20; i++) {
    const baseUrl = credential("models", `LLM_CHANNEL_${i}_BASE_URL`);
    const apiKey = credential("models", `LLM_CHANNEL_${i}_API_KEY`);
    if (!baseUrl || !apiKey) continue;
    const model = process.env[`LLM_CHANNEL_${i}_MODEL`]?.trim() || spec.model;
    const quotaMode = detectQuotaMode(baseUrl, process.env[`LLM_CHANNEL_${i}_QUOTA_MODE`]);
    const extraRaw = process.env[`LLM_CHANNEL_${i}_EXTRA_JSON`];
    const extra = extraRaw !== undefined ? extraFromEnv(extraRaw) : spec.extra;
    channels.push({
      index: i,
      id: `ch-${i}`,
      baseUrl,
      apiKey,
      model,
      quotaMode,
      extra,
    });
  }

  return channels;
}

export type QuotaCheckResult = { exhausted: false } | { exhausted: true; untilMs: number };

const HTTP_QUOTA_EXHAUSTED_RE =
  /\binsufficient_quota\b|\bcredit_balance_exhausted\b|\bsponsored_pool_exhausted\b|\bpool has been used up\b|\bFreeUsageLimitError\b|\bGoUsageLimitError\b|\bfree_usage_limit\b|\bgo_usage_limit\b|\bCreditLimitExceeded\b|\bout of credits\b|\bnot enough credits\b|\binsufficient (?:account |credit )?balance\b|\b(?:credit )?balance (?:is )?(?:exhausted|insufficient)\b|\bfree allocated quota exceeded\b|账户.*欠费|余额不足|额度耗尽/i;

export async function checkChannelQuotaExhausted(
  channel: LlmChannelConfig,
  res: Response | null,
  responseText: string,
  nowMs = Date.now(),
  timeoutMs = 10_000,
): Promise<QuotaCheckResult> {
  const defaultResetMs = getNextUtcResetMs(nowMs);

  if (channel.quotaMode === "apinex" || channel.quotaMode === "subscription") {
    try {
      const subRes = await fetch(`${channel.baseUrl.replace(/\/$/, "")}/subscription`, {
        method: "GET",
        headers: { authorization: `Bearer ${channel.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (subRes.ok) {
        const data = (await subRes.json()) as {
          unlimited?: boolean;
          token_limit?: number | null;
          tokens_used?: number | null;
          tokens_remaining?: number | null;
          allowed?: boolean;
          resets_at_utc?: string | null;
        };
        const limit = typeof data.token_limit === "number" ? data.token_limit : null;
        const remaining = typeof data.tokens_remaining === "number" ? data.tokens_remaining : null;
        const usedPct = limit && limit > 0 && remaining !== null ? Math.round(((limit - remaining) / limit) * 1000) / 10 : null;
        updateChannelQuotaInfo(channel.id, {
          remainingTokens: remaining,
          limitTokens: limit,
          usedPct,
          resetsAt: data.resets_at_utc ?? null,
        });
        if (data.unlimited === true) return { exhausted: false };
        const threshold = getTokenThreshold();
        const exhausted =
          data.allowed === false ||
          (typeof data.tokens_remaining === "number" && data.tokens_remaining <= threshold);
        if (exhausted) {
          return { exhausted: true, untilMs: defaultResetMs };
        }
        return { exhausted: false };
      }
    } catch {
      // ignore subscription lookup failure and fall back to status check below
    }
    if (res?.status === 402) return { exhausted: true, untilMs: defaultResetMs };
    return { exhausted: false };
  }

  if (channel.quotaMode === "tokenharbor") {
    if (!res) return { exhausted: false };
    const usedPctHeader = res.headers.get("x-th-free-used-pct");
    const usedPct = usedPctHeader !== null && usedPctHeader !== "" ? Number(usedPctHeader) : Number.NaN;
    const resetHeader = res.headers.get("x-th-free-resets");
    const parsedReset = resetHeader ? Date.parse(resetHeader) : Number.NaN;
    const untilMs = Number.isFinite(parsedReset) && parsedReset > nowMs ? parsedReset : defaultResetMs;

    if (Number.isFinite(usedPct) || resetHeader) {
      updateChannelQuotaInfo(channel.id, {
        usedPct: Number.isFinite(usedPct) ? usedPct : null,
        resetsAt: Number.isFinite(parsedReset) ? new Date(parsedReset).toISOString() : null,
      });
    }

    if (Number.isFinite(usedPct) && usedPct >= 100) {
      return { exhausted: true, untilMs };
    }
    if (res.status === 402) {
      return { exhausted: true, untilMs };
    }
    if (
      res.status === 429 &&
      (!Number.isFinite(usedPct) || usedPct >= 100) &&
      (/allowance|free[- ]tier|rolling.*7[- ]day/i.test(responseText) || HTTP_QUOTA_EXHAUSTED_RE.test(responseText))
    ) {
      return { exhausted: true, untilMs };
    }
    return { exhausted: false };
  }

  // "nvidia" or "http-status"
  if (!res) return { exhausted: false };
  if (res.status === 402) {
    return { exhausted: true, untilMs: defaultResetMs };
  }
  if ((res.status === 403 || res.status === 429) && HTTP_QUOTA_EXHAUSTED_RE.test(responseText)) {
    return { exhausted: true, untilMs: defaultResetMs };
  }
  return { exhausted: false };
}

async function chatOnce<S extends z.ZodType>(opts: ChatJsonOptions<S>, circuit = false, fallbackFor?: string): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new ModelUnavailableError("Model calls are disabled (MODEL_CALLS_ENABLED=false)");

  const channels = getLlmChannels(spec);
  if (channels.length === 0) {
    throw new ModelUnavailableError(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);
  }

  const throttleKey = spec.service || "llm";
  const throttleIntervalMs = getLlmIntervalMs();

  const { request, temperature, maxTokens, userText } = requestFor(opts, spec);
  const timeoutMs = opts.timeoutMs ?? (circuit ? FAILOVER_TIMEOUT_MS : TIMEOUT_MS);
  let permit: CircuitPermit;
  const baseMessages = [
    // A prompt given as one user message (the title/summary prompts) has no system message.
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    // Multimodal parts go through as parts; plain objects are sent as JSON text.
    { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
  ];

  const receipt = await paidRequest(
    { ...request, fallbackFor },
    async () => {
      let res!: Response;
      let text!: string;
      let usedChannel = channels[0]!;
      let sentAt = new Date().toISOString();
      let httpLatencyMs = 0;
      const attemptedChannels: string[] = [];
      const failoverErrors: Array<{ channelId: string; error: string }> = [];

      // Single-channel mode (no extra fallback channels configured): keep standard 429 retry behavior.
      if (channels.length === 1) {
        const ch = channels[0]!;
        usedChannel = ch;
        attemptedChannels.push(ch.id);
        const activeThrottleKey = `${throttleKey}-${ch.id}`;
        const activeBody: Record<string, unknown> = {
          model: ch.model,
          messages: baseMessages,
          temperature,
          max_tokens: maxTokens,
          ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
          ...(ch.extra ?? {}),
        };
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await throttleService(activeThrottleKey, throttleIntervalMs);
            sentAt = new Date().toISOString();
            const httpStarted = performance.now();
            res = await fetch(`${ch.baseUrl.replace(/\/$/, "")}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${ch.apiKey}` },
              body: JSON.stringify(activeBody),
              signal: AbortSignal.timeout(timeoutMs),
            });
            text = await res.text();
            httpLatencyMs = Math.round(performance.now() - httpStarted);
            if (res.status === 429 && attempt < 3) {
              recordThrottleBackoff(activeThrottleKey);
              const retryAfterMs = Number(res.headers.get("retry-after") || 0) * 1000;
              const backoffMs = Math.max(retryAfterMs, throttleIntervalMs > 0 ? throttleIntervalMs * (attempt + 1) : 2500 * (attempt + 1));
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            assertAccepted(spec.service, res.status, text);
            recordChannelSuccess(ch.id);
            break;
          } catch (error) {
            if (attempt < 3 && error instanceof ProviderRejectedError && error.status === 429) {
              recordThrottleBackoff(activeThrottleKey);
              const backoffMs = throttleIntervalMs > 0 ? throttleIntervalMs * (attempt + 1) : 2500 * (attempt + 1);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            recordChannelFailure(ch.id, Date.now(), String(error));
            const failure = isConnectFailure(error) ? new ProviderRejectedError(`connect failed: ${String(error)}`, null, true) : error;
            if (circuit) await recordModelHealth(spec.service, permit!, failureKind(failure) !== "refused");
            throw failure;
          }
        }
      } else {
        // Multi-channel mode: iterate through currently available channels in priority order.
        if (shouldPersistState()) await syncChannelStatesFromDb();
        const nowMs = Date.now();
        let candidates = channels.filter((ch) => isChannelAvailable(ch.id, nowMs));
        if (candidates.length === 0) {
          candidates = channels;
        }

        let succeeded = false;
        let lastFailure: unknown;

        for (const ch of candidates) {
          if (!isChannelAvailable(ch.id, Date.now()) && candidates.some((c) => isChannelAvailable(c.id, Date.now()))) {
            continue;
          }
          usedChannel = ch;
          attemptedChannels.push(ch.id);
          const activeThrottleKey = `${throttleKey}-${ch.id}`;
          const activeBody: Record<string, unknown> = {
            model: ch.model,
            messages: baseMessages,
            temperature,
            max_tokens: maxTokens,
            ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
            ...(ch.extra ?? {}),
          };
          try {
            await throttleService(activeThrottleKey, throttleIntervalMs);
            sentAt = new Date().toISOString();
            const httpStarted = performance.now();
            res = await fetch(`${ch.baseUrl.replace(/\/$/, "")}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${ch.apiKey}` },
              body: JSON.stringify(activeBody),
              signal: AbortSignal.timeout(timeoutMs),
            });
            text = await res.text();
            httpLatencyMs = Math.round(performance.now() - httpStarted);

            if (!res.ok) {
              if (res.status === 429) recordThrottleBackoff(activeThrottleKey);
              const errSummary = `HTTP ${res.status}: ${text.slice(0, 300)}`;
              failoverErrors.push({ channelId: ch.id, error: errSummary });
              const quota = await checkChannelQuotaExhausted(ch, res, text);
              if (quota.exhausted) {
                markChannelExhausted(ch.id, quota.untilMs, errSummary);
              } else {
                recordChannelFailure(ch.id, Date.now(), errSummary);
              }
              assertAccepted(spec.service, res.status, text);
            }

            // Even on 2xx, check if headers (e.g. TokenHarbor x-th-free-used-pct: 100) indicate quota just hit 100%
            recordChannelSuccess(ch.id);
            if (ch.quotaMode === "tokenharbor") {
              const quota = await checkChannelQuotaExhausted(ch, res, text);
              if (quota.exhausted) {
                markChannelExhausted(ch.id, quota.untilMs);
              }
            }
            succeeded = true;
            break;
          } catch (error) {
            // If fetch threw directly (timeout, network error), res is not set or assertAccepted threw ProviderRejectedError
            if (!(error instanceof ProviderRejectedError)) {
              const errSummary = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);
              failoverErrors.push({ channelId: ch.id, error: errSummary });
              const quota = await checkChannelQuotaExhausted(ch, null, "");
              if (quota.exhausted) {
                markChannelExhausted(ch.id, quota.untilMs, errSummary);
              } else {
                recordChannelFailure(ch.id, Date.now(), errSummary);
              }
            }
            lastFailure = isConnectFailure(error) ? new ProviderRejectedError(`connect failed: ${String(error)}`, null, true) : error;
          }
        }

        if (!succeeded) {
          if (circuit) await recordModelHealth(spec.service, permit!, failureKind(lastFailure) !== "refused");
          throw lastFailure;
        }
      }

      if (circuit) await recordModelHealth(spec.service, permit!, false);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Expected a response object");
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      return {
        response: {
          ...json,
          _sentAt: sentAt,
          _latencyMs: httpLatencyMs,
          _channelId: usedChannel.id,
          _channelIndex: usedChannel.index,
          _channelModel: usedChannel.model,
          _attemptedChannels: attemptedChannels,
          ...(failoverErrors.length > 0 ? { _failoverErrors: failoverErrors } : {}),
        },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: null,
      };
    },
    circuit ? async tx => { permit = await enterModelCircuit(tx, spec.service, timeoutMs); } : undefined,
  );

  const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown> };
  const content = response.choices?.[0]?.message?.content ?? "";
  let parsed: z.infer<S>;
  try {
    parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
  } catch (error) {
    // Unusable output: record it and let a later attempt pay for a fresh answer. A reasoning model that
    // reasoned up to the output limit leaves an empty or cut-off answer; say so, and where to give it room.
    const detail = response.choices?.[0]?.finish_reason === "length"
      ? `output token limit reached (finish_reason=length): a reasoning model may have spent it reasoning; give it room with ${spec.key === "default" ? "LLM_REASONING_TOKENS" : `reasoningTokens on preset ${spec.key}`}. ${String(error)}`
      : String(error);
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${detail.slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${detail.slice(0, 300)}`, receipt.receiptId);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}
