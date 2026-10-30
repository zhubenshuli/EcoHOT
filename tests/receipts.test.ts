// Paid requests: an answer already received is reused, every request actually sent counts against the
// budget (retries of one logical request included), a lost answer is bought again at most once, an
// answer cut off at the output limit says so, and the valve stops calls before they are sent.
import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import {
  CHANNEL_COOLDOWN_MS,
  CHANNEL_STATE_SETTING_KEY,
  chatJson,
  getChannelState,
  getLlmIntervalMs,
  getNextUtcResetMs,
  isChannelAvailable,
  recordChannelSuccess,
  resetChannelStates,
  syncChannelStatesFromDb,
  throttleService,
} from "@aihot/backend/providers/llm";
import { embeddingsAvailable } from "@aihot/backend/providers/embeddings";
import { assertAccepted, failureKind, ProviderRejectedError, BudgetExceededError, logicalKeyFor, markStalePendingReceipts, ModelOutputError, paidRequest, providerStopKey, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";

const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
let answer: (hit: number) => string = () => '{"ok":true}';
const provider = await stub((hit) => ({ id: `stub-${hit}`, choices: [{ message: { content: answer(hit) } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

const ask = (subject: string) =>
  chatJson({ model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

after(async () => {
  await provider.close();
  await closeDb();
});

// HTTP 429 also carries account/plan refusals; the same "insufficient_quota" code means
// temporary TPM throttling at DashScope. A generic quota match gets both decisions wrong.
test("429 distinguishes documented spending refusals from request and token rate limits", () => {
  const cases: [string, unknown, "refused" | "outage"][] = [
    ["llm", { type: "GoUsageLimitError", message: "Go usage limit exceeded" }, "refused"],
    ["llm", { type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" } }, "refused"],
    ["llm", { error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." } }, "refused"],
    ["zhipu", { error: { code: "1113", message: "account unavailable" } }, "refused"],
    ["zhipu", { error: { code: 1308, message: "usage window exhausted" } }, "refused"],
    ["zhipu", { error: { code: "1309", message: "subscription expired" } }, "refused"],
    ["zhipu", { error: { code: "1310", message: "weekly or monthly limit reached" } }, "refused"],
    ["dashscope", { code: "BudgetLimitExceeded", message: "budget reached" }, "refused"],
    ["dashscope", { error: { code: "PrepaidBillOverdue", message: "service expired" } }, "refused"],
    ["dashscope", { error: { code: "PostpaidBillOverdue", message: "service expired" } }, "refused"],
    ["dashscope", { code: "CommodityNotPurchased", message: "subscription missing" }, "refused"],
    ["dashscope", { code: "Throttling.AllocationQuota", message: "Free allocated quota exceeded." }, "refused"],
    ["llm", { error: { message: "x".repeat(900), code: "credit_balance_exhausted" } }, "refused"],
    ["llm", { error: { code: "organization_usage_limit_exceeded" } }, "refused"],
    ["llm", { error: { code: "organization_spend_limit_exceeded" } }, "refused"],
    ["llm", { error: { code: "project_spend_limit_exceeded" } }, "refused"],
    ["mimo", { error: { message: "Insufficient balance" } }, "refused"],
    ["zhipu", { error: { code: "1302", message: "请求频率过高" } }, "outage"],
    ["zhipu", { error: { code: "1305", message: "服务暂时不可用" } }, "outage"],
    ["dashscope", { error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }, "outage"],
    ["dashscope", { code: "Throttling.AllocationQuota", message: "Allocated quota exceeded, please increase your quota limit." }, "outage"],
    ["dashscope", { code: "Throttling.RateQuota", message: "Requests rate limit exceeded, please try again later." }, "outage"],
    ["dashscope", { code: "Throttling.ResourceExhausted", message: "Too many requests." }, "outage"],
    ["deepseek", { error: { message: "Rate limit reached" } }, "outage"],
    ["mimo", { error: { message: "quota exceeded" } }, "outage"],
    ["llm", { error: { code: "insufficient_quota", message: "quota exceeded" } }, "outage"],
    ["llm", { error: { code: "slow_down", message: "rate limit reached" } }, "outage"],
  ];
  for (const [service, response, expected] of cases) {
    assert.throws(() => assertAccepted(service, 429, JSON.stringify(response)), (error: unknown) => {
      assert.ok(error instanceof ProviderRejectedError);
      assert.equal(failureKind(error), expected, `${service}: ${JSON.stringify(response)}`);
      return true;
    });
  }
});

test("the migrations seed a budget for every paid service", async () => {
  const rows = await sql<{ service: string }[]>`SELECT service FROM budgets`;
  const services = new Set(rows.map((r) => r.service));
  for (const s of ["jina", "socialdata", "dajiala", "zhipu", "deepseek", "mimo", "dashscope"]) assert.ok(services.has(s), `no budget for ${s}`);
});

test("an answer already received is reused instead of bought again", async () => {
  answer = () => '{"ok":true}';
  const subject = `reuse-${tag()}`;
  const before = provider.hits();
  const first = await ask(subject);
  const second = await ask(subject);
  assert.equal(provider.hits() - before, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.receiptId, first.receiptId);
});

test("stale recovery waiting on a response transaction preserves its committed answer and attempt", async () => {
  const request = { service: "invariant-recovery-race", purpose: "invariant_test", identity: { race: tag() } };
  const asked = gate();
  const answer = gate();
  let sent = 0;
  const first = paidRequest(request, async () => {
    sent += 1;
    asked.open();
    await answer.promise;
    return { response: { saved: true } };
  });
  await asked.promise;
  const [row] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE logical_key = ${logicalKeyFor(request)}`;
  await sql`UPDATE receipts SET updated_at = now() - interval '11 minutes' WHERE id = ${row!.id}`;

  // Hold only the attempt row: paidRequest can write its received response, but cannot commit yet.
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT id FROM receipt_attempts WHERE receipt_id = ${row!.id} FOR UPDATE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  const waitingOn = async (query: string) => {
    for (let i = 0; i < 500; i++) {
      const waiting = await sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${query}`;
      if (waiting.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`transaction never waited on ${query}`);
  };
  let sweep: Promise<number> | undefined;
  try {
    answer.open();
    await waitingOn("%UPDATE receipt_attempts SET%");
    sweep = markStalePendingReceipts();
    await waitingOn("%UPDATE receipts SET status =%");
  } finally {
    release.open();
    await blocker;
  }
  await first;
  assert.equal(await sweep, 0, "a completed response no longer counts as stale pending");
  const again = await paidRequest(request, async () => {
    sent += 1;
    return { response: { saved: false } };
  });
  assert.equal(sent, 1);
  assert.equal(again.reused, true);
  assert.deepEqual(again.response, { saved: true });
  const [attempt] = await sql<{ status: string }[]>`SELECT status FROM receipt_attempts WHERE receipt_id = ${row!.id}`;
  assert.equal(attempt!.status, "received");
});

test("a fully received non-object model response is unusable output, not an unknown paid outcome", async () => {
  const malformed = await stub(() => null);
  const original = process.env.DEEPSEEK_BASE_URL;
  const subject = `malformed-${tag()}`;
  process.env.DEEPSEEK_BASE_URL = `${malformed.url}/v1`;
  try {
    await assert.rejects(ask(subject), ModelOutputError);
    const [r] = await sql`SELECT status,response FROM receipts WHERE subject=${subject}`;
    assert.equal(r!.status, "failed");
    assert.equal(r!.response.unparsable, "null", "the received provider payload remains inspectable");
    assert.equal(malformed.hits(), 1);
  } finally {
    process.env.DEEPSEEK_BASE_URL = original;
    await malformed.close();
  }
});

test("an answer cut off at the output limit is a failed paid answer that says so", async () => {
  const cut = await stub(() => ({ id: "stub-cut", choices: [{ message: { content: "" }, finish_reason: "length" }], usage }));
  const original = process.env.DEEPSEEK_BASE_URL;
  const subject = `length-${tag()}`;
  process.env.DEEPSEEK_BASE_URL = `${cut.url}/v1`;
  try {
    await assert.rejects(
      chatJson({ model: "deepseek-flash-think", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) }),
      (error: unknown) => error instanceof ModelOutputError && /finish_reason=length/.test(error.message));
    const [r] = await sql`SELECT status, error FROM receipts WHERE subject=${subject}`;
    assert.equal(r!.status, "failed");
    assert.match(r!.error, /finish_reason=length/);
  } finally {
    process.env.DEEPSEEK_BASE_URL = original;
    await cut.close();
  }
});

test("retries of unusable answers stop at the budget, and every request sent is counted", async () => {
  answer = () => "sorry, not json";
  const subject = `budget-${tag()}`;
  // Leave room for exactly two more requests in every window.
  const [c] = await sql<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_minute = ${c!.minute + 2}, per_hour = ${c!.hour + 2}, per_day = ${c!.day + 2} WHERE service = 'deepseek'`;

  const before = provider.hits();
  const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) {
    // What a job retry does: the same logical request again.
    await ask(subject).then(
      () => outcomes.push("ok"),
      (error: unknown) => outcomes.push(error instanceof ModelOutputError ? "unusable" : error instanceof BudgetExceededError ? "budget" : String(error)),
    );
  }
  assert.equal(provider.hits() - before, 2, "requests sent");
  assert.deepEqual(outcomes, ["unusable", "unusable", "budget", "budget", "budget"]);
  const attempts = await sql<{ status: string; tokens: number }[]>`
    SELECT a.status, (a.usage->>'total_tokens')::int AS tokens
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject} ORDER BY a.attempt`;
  assert.deepEqual(attempts.map((a) => a.tokens), [100, 100], "each attempt keeps its own usage");
});

// Failure mode: two workers can both see the last budget slot before either saves its attempt.
test("concurrent distinct requests cannot both spend the last service budget slot", async () => {
  const service = `invariant-concurrent-budget-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 1, 100, 100)`;
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    // Reads still run, but an attempt cannot commit until both workers reach a database lock.
    await tx`LOCK TABLE receipt_attempts IN SHARE MODE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  let sent = 0;
  const send = async () => { sent += 1; return { response: { ok: true } }; };
  const outcomes: Promise<PromiseSettledResult<unknown>>[] = [];
  const request = (identity: string) => {
    outcomes.push(paidRequest({ service, purpose: "invariant_test", identity }, send).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ));
  };
  const waitForBlocked = async (count: number) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`;
      if (rows.length === count) return;
      assert.ok(Date.now() < deadline, `expected ${count} requests at the database barrier, saw ${rows.length}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    request("first");
    await waitForBlocked(1);
    request("second");
    await waitForBlocked(2);
  } finally {
    release.open();
    await blocker;
  }
  const results = await Promise.all(outcomes);
  assert.equal(sent, 1, "only one request may reach the paid provider");
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof BudgetExceededError));
  const [attempts] = await sql<{ count: number }[]>`SELECT count(*) FROM receipt_attempts WHERE service = ${service}`;
  assert.equal(attempts!.count, 1, "the refused request must not reserve another paid attempt");
});

// Failure modes: checking only the shortest window loses sustained-spend limits; counting expired
// attempts never restores the allowance. Exercise each longer window without exhausting the others.
for (const window of [
  { name: "hour", insideMs: 2 * 60_000, expiredMs: 61 * 60_000, perHour: 1, perDay: 100 },
  { name: "day", insideMs: 2 * 3_600_000, expiredMs: 25 * 3_600_000, perHour: 100, perDay: 1 },
]) test(`the ${window.name} budget independently refuses a paid request until its attempt expires`, async () => {
  const service = `invariant-${window.name}-budget-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
    VALUES (${service}, 100, ${window.perHour}, ${window.perDay})`;
  let sent = 0;
  const send = async () => { sent += 1; return { response: { ok: true } }; };
  const first = await paidRequest({ service, purpose: "invariant_test", identity: "first" }, send);
  await sql`UPDATE receipt_attempts SET started_at = ${new Date(Date.now() - window.insideMs)} WHERE receipt_id = ${first.receiptId}`;

  const next = { service, purpose: "invariant_test", identity: "next" };
  await assert.rejects(paidRequest(next, send), BudgetExceededError);
  assert.equal(sent, 1, "the exhausted window prevents sending, even when the other windows have room");

  await sql`UPDATE receipt_attempts SET started_at = ${new Date(Date.now() - window.expiredMs)} WHERE receipt_id = ${first.receiptId}`;
  const resumed = await paidRequest(next, send);
  assert.equal(resumed.reused, false);
  assert.equal(sent, 2, "an expired attempt no longer consumes the service allowance");
});

test("with the valve off nothing is sent", async () => {
  config.modelCallsEnabled = false;
  try {
    const before = provider.hits();
    await assert.rejects(ask(`valve-${tag()}`), /disabled/);
    assert.equal(provider.hits(), before);
    process.env.DASHSCOPE_API_KEY = "test-key";
    assert.equal(embeddingsAvailable(), false);
  } finally {
    config.modelCallsEnabled = true;
    delete process.env.DASHSCOPE_API_KEY;
  }
});

test("an unknown outcome is released automatically once, so a lost answer costs at most one repeat", async () => {
  // A service without a budget row: the budget tests above may have used up deepseek's.
  const req = { service: "invariant-unbudgeted", purpose: "invariant_test", subject: `lost-${tag()}`, identity: { lost: tag() } };
  let sent = 0;
  const lost = () => {
    sent += 1;
    return Promise.reject(new Error("socket hang up after sending"));
  };
  const status = async () => (await sql<{ status: string }[]>`SELECT status FROM receipts WHERE subject = ${req.subject}`)[0]!.status;
  const age = () => sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE subject = ${req.subject}`;

  await assert.rejects(paidRequest(req, lost));
  assert.equal(await status(), "unknown");
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "not within half an hour");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "failed");
  await assert.rejects(paidRequest(req, lost));
  assert.equal(sent, 2, "one repeat after the release");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "a second loss waits for the admin");
  await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
  assert.equal(sent, 2);
});

// The classification the alert layer already uses: a TPM/RPM throttle may pass; an account, spending or
// access refusal stops new calls, because the same request would be refused again in a minute.
test("a throttle is not a spent account: only an access or billing refusal stops calls", () => {
  const throttle = (body: string) => assert.throws(
    () => assertAccepted("dashscope", 429, body),
    (error: unknown) => error instanceof ProviderRejectedError && error.retryable && !error.accessRefused,
  );
  throttle('{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}');
  throttle('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}');
  const refused = (body: string) => assert.throws(
    () => assertAccepted("dashscope", 429, body),
    (error: unknown) => error instanceof ProviderRejectedError && error.accessRefused,
  );
  refused('{"code":"CommodityNotPurchased","message":"product not purchased"}');
  refused('{"type":"error","error":{"type":"GoUsageLimitError","message":"Go plan usage limit reached"}}');
  refused('{"error":{"message":"insufficient balance"}}');
});

test("an access refusal stops new calls until the cooldown, and a real answer releases the stop", async () => {
  const service = `invariant-stop-${tag()}`;
  let sent = 0;
  const refuse = async () => {
    sent += 1;
    assertAccepted(service, 402, '{"error":{"message":"insufficient balance"}}');
    return { response: null };
  };
  try {
    await assert.rejects(paidRequest({ service, purpose: "invariant_test", identity: "first" }, refuse), ProviderRejectedError);
    assert.equal(sent, 1);
    const [stop] = await sql<{ value: { until: string } }[]>`SELECT value FROM settings WHERE key = ${providerStopKey(service)}`;
    assert.ok(stop, "the refusal records a stop");
    // The attempt keeps the provider's own words, so the refused-provider alert classifies it the same way.
    const [attempt] = await sql<{ error: string }[]>`SELECT error FROM receipt_attempts WHERE service = ${service} ORDER BY id DESC LIMIT 1`;
    assert.match(attempt!.error, /insufficient balance/);

    // The next logical request is stopped before it is sent.
    await assert.rejects(paidRequest({ service, purpose: "invariant_test", identity: "second" }, refuse), BudgetExceededError);
    assert.equal(sent, 1, "no request reaches the provider while the stop holds");

    // A stop, not a verdict: once the cooldown runs out a probe is allowed.
    await sql`UPDATE settings SET value = jsonb_build_object('until', ${new Date(Date.now() - 1000).toISOString()}::text) WHERE key = ${providerStopKey(service)}`;
    const ok = await paidRequest({ service, purpose: "invariant_test", identity: "third" }, async () => { sent += 1; return { response: { ok: true } }; });
    assert.ok(ok.receiptId);
    assert.equal(sent, 2, "calls resume after the cooldown");
    assert.equal((await sql`SELECT 1 FROM settings WHERE key = ${providerStopKey(service)}`).length, 0, "a received answer releases the stop");
  } finally {
    await sql`DELETE FROM receipts WHERE service = ${service}`;
    await sql`DELETE FROM settings WHERE key = ${providerStopKey(service)}`;
  }
});

test("a TPM throttle does not stop the service", async () => {
  const service = `invariant-throttle-${tag()}`;
  let sent = 0;
  try {
    await assert.rejects(paidRequest({ service, purpose: "invariant_test", identity: "throttle" }, async () => {
      sent += 1;
      assertAccepted(service, 429, '{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}');
      return { response: null };
    }), ProviderRejectedError);
    assert.equal(sent, 1);
    assert.equal((await sql`SELECT 1 FROM settings WHERE key = ${providerStopKey(service)}`).length, 0, "a temporary throttle leaves the service callable");
  } finally {
    await sql`DELETE FROM receipts WHERE service = ${service}`;
  }
});
test("a resource-level 403 (a private account) stops nothing", async () => {
  const service = `invariant-private-${tag()}`;
  try {
    await assert.rejects(paidRequest({ service, purpose: "invariant_test", identity: "private" }, async () => {
      assertAccepted(service, 403, '{"error":{"message":"Forbidden: user privacy settings"}}');
      return { response: null };
    }), ProviderRejectedError);
    assert.equal((await sql`SELECT 1 FROM settings WHERE key = ${providerStopKey(service)}`).length, 0, "one private resource does not stop the service");
  } finally {
    await sql`DELETE FROM receipts WHERE service = ${service}`;
  }
});

test("one model's spent quota stops that model, not the service's other models", async () => {
  // dashscope's free quota is per model: the refused-provider alert is per model too (operations/alerts.ts).
  const vision = `vision-${tag()}`;
  const text = `text-${tag()}`;
  try {
    await assert.rejects(paidRequest({ service: "dashscope", model: vision, purpose: "invariant_test", identity: "vision" }, async () => {
      assertAccepted("dashscope", 429, '{"code":"Throttling.AllocationQuota","message":"Free allocated quota exceeded."}');
      return { response: null };
    }), ProviderRejectedError);
    assert.equal((await sql`SELECT 1 FROM settings WHERE key = ${providerStopKey("dashscope", vision)}`).length, 1, "the refused model is stopped");
    let sent = 0;
    await paidRequest({ service: "dashscope", model: text, purpose: "invariant_test", identity: "text" }, async () => { sent += 1; return { response: { ok: true } }; });
    assert.equal(sent, 1, "another model of the same service is still called");
  } finally {
    await sql`DELETE FROM receipts WHERE service = 'dashscope' AND model IN (${vision}, ${text})`;
    await sql`DELETE FROM settings WHERE key = ${providerStopKey("dashscope", vision)}`;
  }
});

test("llm rpm rate limiting and serial throttle queuing", async () => {
  delete process.env.LLM_RPM;
  assert.equal(getLlmIntervalMs(), 12_000); // 默认 12 秒 (RPM = 5)
  process.env.LLM_RPM = "60";
  assert.equal(getLlmIntervalMs(), 1000); // 60 RPM -> 1000ms
  process.env.LLM_RPM = "0";
  assert.equal(getLlmIntervalMs(), 0);
  delete process.env.LLM_RPM;

  const key = `test-throttle-${tag()}`;
  const start = Date.now();
  await throttleService(key, 80);
  const first = Date.now() - start;
  await throttleService(key, 80);
  const second = Date.now() - start;
  assert.ok(first < 50, "first request proceeds immediately");
  assert.ok(second >= 75, "second request is throttled by min interval");
});

test("multi-channel llm: per-channel quota exhaustion, transient failover, and 3-failure 1h cooldown", async () => {
  const now = Date.UTC(2026, 9, 28, 10, 30, 0);
  assert.equal(getNextUtcResetMs(now), Date.UTC(2026, 9, 29, 1, 0, 0));
  const afterMidnightBefore1Am = Date.UTC(2026, 9, 29, 0, 30, 0);
  assert.equal(getNextUtcResetMs(afterMidnightBefore1Am), Date.UTC(2026, 9, 29, 1, 0, 0));

  let ch1Behavior: "ok" | "transient" | "quota" = "transient";
  let ch2QuotaRemaining = 100_000;
  let ch1Calls = 0;
  let ch2Calls = 0;
  let ch2SubChecks = 0;
  let ch3Calls = 0;
  const usedModels: string[] = [];

  // Channel 1: NVIDIA style (http-status quota detection)
  const ch1Server = await stub((hit, req) => {
    ch1Calls++;
    const model = (JSON.parse(req.body) as { model: string }).model;
    if (ch1Behavior === "ok") {
      usedModels.push(model);
      return { id: `ch1-${hit}`, choices: [{ message: { content: '{"ok":true}' } }], usage };
    }
    if (ch1Behavior === "quota") {
      return new Reply(402, { error: { message: "Account out of credits" } });
    }
    return new Reply(504, { error: { message: "Gateway timeout" } });
  });

  // Channel 2: Apinex style (/subscription quota detection)
  const ch2Server = await stub((hit, req) => {
    if (req.url === "/v1/subscription") {
      ch2SubChecks++;
      return {
        object: "subscription",
        unlimited: false,
        tokens_remaining: ch2QuotaRemaining,
        resets_at_utc: "2026-10-30T00:00:00.000Z",
        allowed: ch2QuotaRemaining > 0,
      };
    }
    ch2Calls++;
    const model = (JSON.parse(req.body) as { model: string }).model;
    if (ch2QuotaRemaining <= 50_000) {
      return new Reply(429, { error: { message: "quota exceeded" } });
    }
    usedModels.push(model);
    return { id: `ch2-${hit}`, choices: [{ message: { content: '{"ok":true}' } }], usage };
  });

  // Channel 3: TokenHarbor style (response header quota detection)
  const ch3Server = await stub((hit, req) => {
    ch3Calls++;
    const model = (JSON.parse(req.body) as { model: string }).model;
    usedModels.push(model);
    return new Reply(
      200,
      { id: `ch3-${hit}`, choices: [{ message: { content: '{"ok":true}' } }], usage },
      { "x-th-free-used-pct": "100", "x-th-free-resets": "2026-11-04T10:00:00.000Z" },
    );
  });

  const envKeys = [
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_CHANNEL_1_QUOTA_MODE",
    "LLM_CHANNEL_2_BASE_URL",
    "LLM_CHANNEL_2_API_KEY",
    "LLM_CHANNEL_2_MODEL",
    "LLM_CHANNEL_2_QUOTA_MODE",
    "LLM_CHANNEL_3_BASE_URL",
    "LLM_CHANNEL_3_API_KEY",
    "LLM_CHANNEL_3_MODEL",
    "LLM_CHANNEL_3_QUOTA_MODE",
    "LLM_TOKEN_THRESHOLD",
    "LLM_RPM",
  ] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of envKeys) prevEnv[k] = process.env[k];

  const callDefault = (label: string) =>
    chatJson({
      model: "default",
      purpose: "invariant_test",
      subject: `mc-${label}-${tag()}`,
      promptVersion: "t1",
      system: "s",
      user: label,
      schema: z.object({ ok: z.boolean() }),
    });

  try {
    resetChannelStates();
    Object.assign(process.env, {
      LLM_BASE_URL: `${ch1Server.url}/v1`,
      LLM_API_KEY: "ch1-key",
      LLM_MODEL: "minimaxai/minimax-m3.1-flash",
      LLM_CHANNEL_1_QUOTA_MODE: "nvidia",
      LLM_CHANNEL_2_BASE_URL: `${ch2Server.url}/v1`,
      LLM_CHANNEL_2_API_KEY: "ch2-key",
      LLM_CHANNEL_2_MODEL: "free/deepseek-v4.1-flash",
      LLM_CHANNEL_2_QUOTA_MODE: "apinex",
      LLM_CHANNEL_3_BASE_URL: `${ch3Server.url}/v1`,
      LLM_CHANNEL_3_API_KEY: "ch3-key",
      LLM_CHANNEL_3_MODEL: "deepseek-v4.1-flash:free",
      LLM_CHANNEL_3_QUOTA_MODE: "tokenharbor",
      LLM_TOKEN_THRESHOLD: "50000",
      LLM_RPM: "0",
    });

    // 1. First transient error on ch-1 -> temporarily uses ch-2, next request returns to ch-1
    ch1Behavior = "transient";
    await callDefault("req1");
    assert.equal(ch1Calls, 1, "req1 tried ch-1 first");
    assert.equal(ch2Calls, 1, "req1 failed over to ch-2");
    assert.equal(getChannelState("ch-1").consecutiveFailures, 1);
    assert.equal(isChannelAvailable("ch-1"), true, "ch-1 not in cooldown after 1 failure");

    // 2. Next request returns to ch-1; when ch-1 succeeds, failure count resets to 0
    ch1Behavior = "ok";
    await callDefault("req2");
    assert.equal(ch1Calls, 2, "req2 returned to ch-1");
    assert.equal(ch2Calls, 1, "ch-2 was not needed");
    assert.equal(getChannelState("ch-1").consecutiveFailures, 0, "ch-1 failure count reset on success");

    // 3. Three consecutive failures on ch-1 -> triggers 1h cooldown on ch-1
    ch1Behavior = "transient";
    await callDefault("req3-fail1");
    assert.equal(getChannelState("ch-1").consecutiveFailures, 1);
    await callDefault("req4-fail2");
    assert.equal(getChannelState("ch-1").consecutiveFailures, 2);
    assert.equal(isChannelAvailable("ch-1"), true, "still available after 2 failures");

    const before3rdFail = Date.now();
    await callDefault("req5-fail3");
    assert.equal(ch1Calls, 5, "tried ch-1 3 consecutive times");
    assert.equal(getChannelState("ch-1").consecutiveFailures, 3, "counter stays at failure limit during cooldown");
    assert.ok(getChannelState("ch-1").cooldownUntil >= before3rdFail + CHANNEL_COOLDOWN_MS - 1000, "1h cooldown set");
    assert.equal(isChannelAvailable("ch-1"), false, "ch-1 is now in cooldown");

    // 4. Subsequent request skips ch-1 during cooldown and goes directly to ch-2
    await callDefault("req6-during-cooldown");
    assert.equal(ch1Calls, 5, "ch-1 was skipped while cooling down");
    assert.equal(ch2Calls, 5, "went straight to ch-2");
    assert.equal(isChannelAvailable("ch-1", before3rdFail + CHANNEL_COOLDOWN_MS + 2000), true);
    assert.equal(getChannelState("ch-1").consecutiveFailures, 0, "counter resets once cooldown expires");

    // 5. Quota exhaustion cascade: reset states, ch-1 quota exhausted -> ch-2 quota exhausted -> ch-3
    resetChannelStates();
    ch1Behavior = "quota";
    ch2QuotaRemaining = 5000; // <= 50,000 threshold
    await callDefault("req7-cascade");
    assert.equal(ch1Calls, 6, "tried ch-1 and hit 402 quota error");
    assert.equal(isChannelAvailable("ch-1"), false, "ch-1 marked exhausted");
    assert.equal(ch2Calls, 6, "tried ch-2 and hit 429");
    assert.equal(ch2SubChecks, 1, "ch-2 checked /v1/subscription");
    assert.equal(isChannelAvailable("ch-2"), false, "ch-2 marked exhausted via subscription");
    assert.equal(ch3Calls, 1, "cascaded to ch-3");
    // ch-3 returned x-th-free-used-pct: 100, so it also proactively marks itself exhausted until x-th-free-resets
    assert.equal(getChannelState("ch-3").exhaustedUntil, Date.parse("2026-11-04T10:00:00.000Z"));

    // 6. Cross-process DB sync: an older in-memory state in API is updated when worker writes newer lastSuccessAt to DB
    resetChannelStates();
    const olderMs = Date.parse("2026-10-29T03:00:00.000Z");
    const newerIso = "2026-10-29T05:40:00.000Z";
    recordChannelSuccess("ch-1", olderMs);
    assert.equal(getChannelState("ch-1").lastSuccessAt, "2026-10-29T03:00:00.000Z");
    await sql`INSERT INTO settings (key, value, updated_by)
              VALUES (${CHANNEL_STATE_SETTING_KEY}, ${sql.json({ "ch-1": { consecutiveFailures: 0, cooldownUntil: 0, exhaustedUntil: 0, lastSuccessAt: newerIso } } as never)}, 'llm-pool')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    await syncChannelStatesFromDb();
    assert.equal(getChannelState("ch-1").lastSuccessAt, newerIso, "newer worker lastSuccessAt replaces stale local cache");
  } finally {
    resetChannelStates();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ch1Server.close();
    await ch2Server.close();
    await ch3Server.close();
  }
});
