// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import type { AdminChannels, AdminModels, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { capabilities, capabilityAcceptsModel, fallbackModelFor, invalidateModelCache, modelSources } from "../editorial/models.ts";
import {
  CHANNEL_FAILURE_LIMIT,
  CHANNEL_STATE_SETTING_KEY,
  getChannelState,
  getLlmChannels,
  getLlmIntervalMs,
  getTokenThreshold,
  isChannelAvailable,
  MODELS,
  syncChannelStatesFromDb,
  type LlmChannelConfig,
  type LlmChannelQuotaInfo,
  type LlmChannelState,
} from "../providers/llm.ts";
import { modelCircuits } from "../providers/circuit.ts";
import { audit } from "../audit.ts";

interface UsageRow {
  purpose: string;
  model: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  /** Prompt tokens served from the provider's cache, among those without a cost of their own. */
  tokens_cached: string | null;
  tokens_out: string | null;
  /** Of calls without a cost of their own. */
  tokens_in_uncosted: string | null;
  tokens_out_uncosted: string | null;
  actual_cost: string | null;
  currency: string | null;
}

export async function modelsOverview(days = 7): Promise<BeforeJson<AdminModels>> {
  const since = new Date(Date.now() - days * 86400_000);
  const [sources, circuits, usage, prices, history, benches] = await Promise.all([
    modelSources(),
    modelCircuits(),
    sql<UsageRow[]>`
      SELECT r.purpose, a.model, r.request->>'promptVersion' AS prompt_version, count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
             sum((a.usage->>'prompt_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_in_uncosted,
             sum((a.usage->>'completion_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_out_uncosted,
             sum(coalesce((a.usage->'prompt_tokens_details'->>'cached_tokens')::bigint, (a.usage->>'prompt_cache_hit_tokens')::bigint, 0)) FILTER (WHERE a.cost IS NULL) AS tokens_cached,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost, max(a.currency) AS currency
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL
      GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC`,
    sql<{ service: string; model: string; currency: string; input_per_mtok: string | null; cached_per_mtok: string | null; output_per_mtok: string | null }[]>`
      SELECT service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok FROM service_prices`,
    sql<BeforeJson<AdminModels["history"][number]>[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`,
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
  ]);
  const serviceOf = (model: string) => Object.values(MODELS).find((m) => m.model === model || m.key === model)?.service ?? null;
  // Cached prompt tokens at the cache price, the rest at the input price; calls that carry their own cost
  // are not estimated again.
  const priced = (u: UsageRow) => {
    const service = u.model ? serviceOf(u.model) : null;
    const p = prices.find((x) => x.service === service && x.model === u.model) ?? prices.find((x) => x.service === service && x.model === "");
    if (!p || (!p.input_per_mtok && !p.output_per_mtok)) return null;
    const cached = Number(u.tokens_cached ?? 0);
    const fresh = Number(u.tokens_in_uncosted ?? 0) - cached;
    const amount = (fresh / 1e6) * Number(p.input_per_mtok ?? 0) + (cached / 1e6) * Number(p.cached_per_mtok ?? p.input_per_mtok ?? 0) + (Number(u.tokens_out_uncosted ?? 0) / 1e6) * Number(p.output_per_mtok ?? 0);
    return { amount, currency: p.currency };
  };
  const steps = Object.entries(capabilities()).map(([key, c]) => {
    const backup = fallbackModelFor(key, sources[key]!.model);
    const primaryCircuit = circuits[MODELS[sources[key]!.model]!.service];
    const backupCircuit = backup ? circuits[MODELS[backup]!.service] : undefined;
    return {
      key,
      label: c.label,
      env: c.env,
      defaultModel: c.default,
      vision: !!c.vision,
      current: sources[key]!,
      fallback: backup ? { model: backup, primaryPaused: !!primaryCircuit?.openUntil, backupPaused: !!backupCircuit?.openUntil,
        nextProbeAt: primaryCircuit?.openUntil ? new Date(Math.max(primaryCircuit.openUntil, primaryCircuit.probeUntil)).toISOString() : null } : null,
      usage: usage
        .filter((u) => c.purposes.includes(u.purpose))
        .map((u) => ({
          purpose: u.purpose,
          model: u.model,
          promptVersion: u.prompt_version,
          calls: u.calls,
          ok: u.ok,
          failed: u.failed,
          unknown: u.unknown,
          p50: u.p50,
          p95: u.p95,
          tokensIn: Number(u.tokens_in ?? 0),
          tokensOut: Number(u.tokens_out ?? 0),
          actualCost: u.actual_cost === null ? null : Number(u.actual_cost),
          currency: u.currency,
          estimate: priced(u),
        })),
    };
  });
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  return { days, capabilities: steps, choices, history, benches };
}

/** Switches a capability to another registered model (or back to the environment/default when null). */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  const c = capabilities()[capability];
  if (!c) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (model !== null) {
    const spec = MODELS[model];
    if (!spec) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
    if (!capabilityAcceptsModel(c, spec)) throw Object.assign(new Error("this capability needs a vision model"), { statusCode: 400 });
  }
  const before = (await modelSources())[capability];
  if (model === null) await sql`DELETE FROM settings WHERE key = ${`models.${capability}`}`;
  else {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`models.${capability}`}, ${sql.json({ model })}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  invalidateModelCache();
  const after = (await modelSources())[capability];
  await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after ?? null);
  return { capability, before, after };
}

function hostOfUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx]!;
}

async function fetchLiveSubscriptionQuota(ch: LlmChannelConfig): Promise<LlmChannelQuotaInfo | null> {
  if (ch.quotaMode !== "apinex" && ch.quotaMode !== "subscription") return null;
  try {
    const res = await fetch(`${ch.baseUrl.replace(/\/$/, "")}/subscription`, {
      method: "GET",
      headers: { authorization: `Bearer ${ch.apiKey}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      token_limit?: number | null;
      tokens_remaining?: number | null;
      resets_at_utc?: string | null;
    };
    const limit = typeof data.token_limit === "number" ? data.token_limit : null;
    const remaining = typeof data.tokens_remaining === "number" ? data.tokens_remaining : null;
    const usedPct = limit && limit > 0 && remaining !== null ? Math.round(((limit - remaining) / limit) * 1000) / 10 : null;
    return {
      remainingTokens: remaining,
      limitTokens: limit,
      usedPct,
      resetsAt: data.resets_at_utc ?? null,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

interface ChannelReceiptRow {
  id: number;
  purpose: string;
  subject: string | null;
  status: string;
  model: string | null;
  channel_id: string | null;
  channel_index: number | null;
  response_model: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  attempted_channels: unknown;
  failover_errors: unknown;
  error: string | null;
  created_at: Date;
}

export async function channelsOverview(days = 0): Promise<BeforeJson<AdminChannels>> {
  const now = new Date();
  const since =
    days <= 0
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
      : new Date(now.getTime() - days * 86400_000);
  const channels = getLlmChannels(MODELS.default!);
  await syncChannelStatesFromDb({ force: true });
  const liveQuotas = new Map<string, LlmChannelQuotaInfo | null>(
    await Promise.all(channels.map(async (ch) => [ch.id, await fetchLiveSubscriptionQuota(ch)] as const)),
  );

  const rows = await sql<ChannelReceiptRow[]>`
    SELECT id,
           purpose,
           subject,
           status,
           model,
           response->>'_channelId' AS channel_id,
           (response->>'_channelIndex')::int AS channel_index,
           coalesce(response->>'_channelModel', response->>'model', model) AS response_model,
           (response->>'_latencyMs')::int AS latency_ms,
           (usage->>'prompt_tokens')::int AS tokens_in,
           (usage->>'completion_tokens')::int AS tokens_out,
           response->'_attemptedChannels' AS attempted_channels,
           response->'_failoverErrors' AS failover_errors,
           error,
           coalesce((response->>'_sentAt')::timestamptz, created_at) AS created_at
    FROM receipts
    WHERE service = 'llm' AND origin = 'live' AND created_at >= ${since}
    ORDER BY coalesce((response->>'_sentAt')::timestamptz, created_at) DESC, id DESC`;

  const resolveChannelId = (r: ChannelReceiptRow): string | null => {
    if (r.channel_id && channels.some((c) => c.id === r.channel_id)) return r.channel_id;
    const candidates = [r.response_model?.trim(), r.model?.trim()].filter((x): x is string => !!x);
    for (const rm of candidates) {
      const exact = channels.find((c) => c.model.toLowerCase() === rm.toLowerCase());
      if (exact) return exact.id;
      const stripped = channels.find((c) => c.model.toLowerCase().replace(/:free$/, "") === rm.toLowerCase());
      if (stripped) return stripped.id;
    }
    return null;
  };

  const nowMs = Date.now();
  const activeChannel = channels.find((c) => isChannelAvailable(c.id, nowMs)) ?? channels[0] ?? null;

  const failoverRowsByCh = new Map<string, ChannelReceiptRow[]>();
  for (const r of rows) {
    if (Array.isArray(r.attempted_channels) && r.attempted_channels.length > 1) {
      for (const chId of r.attempted_channels.slice(0, -1)) {
        if (typeof chId === "string") {
          let list = failoverRowsByCh.get(chId);
          if (!list) {
            list = [];
            failoverRowsByCh.set(chId, list);
          }
          list.push(r);
        }
      }
    }
  }

  const channelItems: BeforeJson<AdminChannels["channels"]> = channels.map((ch) => {
    const state = getChannelState(ch.id);
    const isExhausted = nowMs < state.exhaustedUntil;
    const isCooldown = !isExhausted && nowMs < state.cooldownUntil;
    const available = !isExhausted && !isCooldown;
    const status: "active" | "standby" | "cooldown" | "exhausted" = isExhausted
      ? "exhausted"
      : isCooldown
        ? "cooldown"
        : activeChannel?.id === ch.id
          ? "active"
          : "standby";

    const chRows = rows.filter((r) => resolveChannelId(r) === ch.id);
    const chFailoverRows = failoverRowsByCh.get(ch.id) ?? [];
    const latencies = chRows
      .map((r) => r.latency_ms)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => a - b);

    const byPurpose = new Map<string, { landed: ChannelReceiptRow[]; failedOver: ChannelReceiptRow[] }>();
    for (const r of chRows) {
      let bucket = byPurpose.get(r.purpose);
      if (!bucket) {
        bucket = { landed: [], failedOver: [] };
        byPurpose.set(r.purpose, bucket);
      }
      bucket.landed.push(r);
    }
    for (const r of chFailoverRows) {
      let bucket = byPurpose.get(r.purpose);
      if (!bucket) {
        bucket = { landed: [], failedOver: [] };
        byPurpose.set(r.purpose, bucket);
      }
      bucket.failedOver.push(r);
    }

    const usage = Array.from(byPurpose.entries())
      .map(([purpose, { landed, failedOver }]) => {
        const lats = landed
          .map((r) => r.latency_ms)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
          .sort((a, b) => a - b);
        const okCount = landed.filter((r) => r.status === "received" || r.status === "completed").length;
        const failCount = landed.filter((r) => r.status === "failed" || r.status === "unknown").length + failedOver.length;
        const latestLanded = landed[0]?.created_at ?? null;
        const latestFailover = failedOver[0]?.created_at ?? null;
        const lastAt =
          latestLanded && latestFailover
            ? latestLanded > latestFailover
              ? latestLanded
              : latestFailover
            : latestLanded ?? latestFailover;
        return {
          purpose,
          calls: okCount + failCount,
          ok: okCount,
          failed: failCount,
          p50: percentile(lats, 0.5),
          p95: percentile(lats, 0.95),
          tokensIn: landed.reduce((acc, r) => acc + (r.tokens_in ?? 0), 0),
          tokensOut: landed.reduce((acc, r) => acc + (r.tokens_out ?? 0), 0),
          lastAt,
        };
      })
      .sort((a, b) => b.calls - a.calls);

    const totalOk = chRows.filter((r) => r.status === "received" || r.status === "completed").length;
    const totalFailed = chRows.filter((r) => r.status === "failed" || r.status === "unknown").length + chFailoverRows.length;
    const latestReceiptOkAt = chRows.find((r) => r.status === "received" || r.status === "completed")?.created_at ?? null;
    const stateOkAt = state.lastSuccessAt ? new Date(state.lastSuccessAt) : null;
    const validStateOkAt = stateOkAt && !Number.isNaN(stateOkAt.getTime()) ? stateOkAt : null;
    const lastSuccessAt =
      validStateOkAt && latestReceiptOkAt
        ? validStateOkAt > latestReceiptOkAt
          ? validStateOkAt
          : latestReceiptOkAt
        : validStateOkAt ?? latestReceiptOkAt;
    const mergedQuota = liveQuotas.get(ch.id) ?? state.quotaInfo ?? null;

    const chFailures: Array<{ at: Date; error: string; receiptId: number | null; purpose: string | null }> = [];
    const addFailure = (f: { at: Date; error: string; receiptId: number | null; purpose: string | null }) => {
      const duplicate = chFailures.find((existing) => {
        if (f.receiptId && existing.receiptId && f.receiptId === existing.receiptId) return true;
        const timeDiff = Math.abs(existing.at.getTime() - f.at.getTime());
        if (timeDiff <= 10_000) {
          if (existing.error === f.error || existing.error.startsWith(f.error) || f.error.startsWith(existing.error)) {
            return true;
          }
        }
        return false;
      });
      if (duplicate) {
        if (!duplicate.receiptId && f.receiptId) {
          duplicate.receiptId = f.receiptId;
          duplicate.purpose = f.purpose;
          duplicate.at = f.at;
        }
        return;
      }
      chFailures.push(f);
    };

    for (const r of chFailoverRows) {
      let matched = false;
      if (Array.isArray(r.failover_errors)) {
        for (const fe of r.failover_errors) {
          if (fe && typeof fe === "object" && (fe as { channelId?: string }).channelId === ch.id && typeof (fe as { error?: string }).error === "string") {
            addFailure({
              at: r.created_at,
              error: (fe as { error: string }).error,
              receiptId: r.id,
              purpose: r.purpose,
            });
            matched = true;
          }
        }
      }
      if (!matched && r.error) {
        addFailure({
          at: r.created_at,
          error: r.error,
          receiptId: r.id,
          purpose: r.purpose,
        });
      }
    }
    for (const r of chRows) {
      if ((r.status === "failed" || r.status === "unknown") && r.error) {
        addFailure({
          at: r.created_at,
          error: r.error,
          receiptId: r.id,
          purpose: r.purpose,
        });
      }
    }
    if (Array.isArray(state.recentFailures)) {
      for (const rf of state.recentFailures) {
        if (rf && typeof rf.error === "string" && rf.at) {
          const d = new Date(rf.at);
          if (!Number.isNaN(d.getTime())) {
            addFailure({
              at: d,
              error: rf.error,
              receiptId: null,
              purpose: null,
            });
          }
        }
      }
    }
    if (state.lastError && state.lastErrorAt) {
      const d = new Date(state.lastErrorAt);
      if (!Number.isNaN(d.getTime())) {
        addFailure({
          at: d,
          error: state.lastError,
          receiptId: null,
          purpose: null,
        });
      }
    }
    chFailures.sort((a, b) => b.at.getTime() - a.at.getTime());
    const recentFailures = chFailures.slice(0, 20).map((f) => ({
      at: f.at,
      error: f.error,
      receiptId: f.receiptId,
      purpose: f.purpose,
    }));

    return {
      id: ch.id,
      index: ch.index,
      host: hostOfUrl(ch.baseUrl),
      baseUrl: ch.baseUrl,
      model: ch.model,
      quotaMode: ch.quotaMode,
      status,
      available,
      consecutiveFailures: state.consecutiveFailures,
      failureLimit: CHANNEL_FAILURE_LIMIT,
      cooldownUntil: isCooldown ? new Date(state.cooldownUntil) : null,
      exhaustedUntil: isExhausted ? new Date(state.exhaustedUntil) : null,
      lastSuccessAt,
      lastErrorAt: state.lastErrorAt ?? null,
      lastError: state.lastError ?? null,
      recentFailures,
      quotaInfo: mergedQuota
        ? {
            usedPct: mergedQuota.usedPct ?? null,
            remainingTokens: mergedQuota.remainingTokens ?? null,
            limitTokens: mergedQuota.limitTokens ?? null,
            resetsAt: mergedQuota.resetsAt ?? null,
            updatedAt: mergedQuota.updatedAt ?? null,
          }
        : null,
      totals: {
        calls: totalOk + totalFailed,
        ok: totalOk,
        failed: totalFailed,
        failoverFrom: chFailoverRows.length,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        tokensIn: chRows.reduce((acc, r) => acc + (r.tokens_in ?? 0), 0),
        tokensOut: chRows.reduce((acc, r) => acc + (r.tokens_out ?? 0), 0),
      },
      usage,
    };
  });

  const recentCalls: BeforeJson<AdminChannels["recentCalls"]> = rows
    .filter((r) => r.status !== "pending")
    .slice(0, 30)
    .map((r) => {
    const chId = resolveChannelId(r);
    const chObj = channels.find((c) => c.id === chId);
    const attempted = Array.isArray(r.attempted_channels)
      ? r.attempted_channels.filter((x): x is string => typeof x === "string")
      : chId
        ? [chId]
        : [];
    const failoverErrors = Array.isArray(r.failover_errors)
      ? r.failover_errors
          .filter(
            (x): x is { channelId: string; error: string } =>
              !!x && typeof x === "object" && typeof (x as { channelId?: unknown }).channelId === "string" && typeof (x as { error?: unknown }).error === "string",
          )
          .map((x) => ({ channelId: x.channelId, error: x.error }))
      : [];
    return {
      id: r.id,
      channelId: chId,
      channelIndex: chObj?.index ?? r.channel_index ?? null,
      model: r.response_model ?? chObj?.model ?? r.model,
      purpose: r.purpose,
      subject: r.subject,
      status: r.status,
      latencyMs: r.latency_ms,
      tokensIn: r.tokens_in ?? 0,
      tokensOut: r.tokens_out ?? 0,
      attemptedChannels: attempted,
      failoverErrors,
      error: r.error,
      at: r.created_at,
    };
  });

  const intervalMs = getLlmIntervalMs();
  const rpm = intervalMs > 0 ? Math.round(60_000 / intervalMs) : 0;

  return {
    days,
    rpm,
    intervalMs,
    tokenThreshold: getTokenThreshold(),
    activeChannelId: activeChannel?.id ?? null,
    channels: channelItems,
    recentCalls,
  };
}

export async function resetChannelAdminState(channelId: string, reason: string, actor: string) {
  const channels = getLlmChannels(MODELS.default!);
  const saved = await syncChannelStatesFromDb({ force: true });
  const targetIds = channelId === "all" ? channels.map((c) => c.id) : [channelId];
  for (const id of targetIds) {
    if (!channels.some((c) => c.id === id)) {
      throw Object.assign(new Error(`unknown channel ${id}`), { statusCode: 400 });
    }
  }
  const now = Date.now();
  const patch: Record<string, LlmChannelState> = {};
  for (const id of targetIds) {
    const local = getChannelState(id);
    local.consecutiveFailures = 0;
    local.cooldownUntil = 0;
    local.exhaustedUntil = 0;
    local.lastError = null;
    local.lastErrorAt = null;
    local.recentFailures = [];
    local.resetAt = now;
    local.updatedAtMs = now;
    patch[id] = { ...local };
  }
  await sql`INSERT INTO settings (key, value, updated_by)
            VALUES (${CHANNEL_STATE_SETTING_KEY}, ${sql.json(patch as never)}, ${actor})
            ON CONFLICT (key) DO UPDATE
            SET value = coalesce(settings.value, '{}'::jsonb) || EXCLUDED.value,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()`;
  await audit(actor, "channels.reset", `channel:${channelId}`, reason || "手动重置通道状态", saved[channelId] ?? null, patch[channelId] ?? null);
  return { ok: true, channelId };
}
