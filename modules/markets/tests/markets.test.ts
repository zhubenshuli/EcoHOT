// The markets page: what is read when, what is kept, and the changes and benchmarks its panels show.
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { addDays } from "@aihot/contracts/time";
import {
  buildWeeklyTrendSeries,
  computeHogProfitMetrics,
  computePigGrainSeries,
  computePorkBenchmark,
  computeRuleBasedPorkAnalysis,
  despikeDailySeries,
  GRAMS_PER_TROY_OUNCE,
  INSTRUMENTS,
  inSession,
  normalizeDay,
  parseKlines,
  parseMoaFarmDailyPork,
  parseZhuePriceCure,
  PORK_THRESHOLDS,
  pruneMarkets,
  readMarkets,
  refreshMacroMarkets,
  refreshMarkets,
  refreshPorkDaily,
  type FetchCloses,
  type FetchRate,
} from "../quotes.ts";
import type { MarketQuote } from "../types.ts";

after(() => closeDb());
beforeEach(() => Promise.all([
  sql`DELETE FROM market_daily_closes`,
  sql`DELETE FROM settings WHERE key = 'markets.pork_analysis'`,
]));

/** `count` closes on consecutive days ending 2026-10-28, the last one `last`, every earlier one 100 + its index. */
const closes = (count: number, last: number) =>
  Array.from({ length: count }, (_, i) => ({ day: addDays("2026-10-28", i - count + 1), close: i === count - 1 ? last : 100 + i }));

const stubRate: FetchRate = async () => 7.0;

test("each market is read only while it trades, Beijing time, wherever the machine runs", () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(inSession("a-share", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("a-share", at("2026-10-28T12:00:00+08:00")), false, "lunch break");
  assert.equal(inSession("a-share", at("2026-10-28T15:10:00+08:00")), true, "the final close");
  assert.equal(inSession("a-share", at("2026-10-31T10:00:00+08:00")), false, "Saturday");
  assert.equal(inSession("hk", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("hk", at("2026-10-28T12:00:00+08:00")), true, "trading until 12:00");
  assert.equal(inSession("hk", at("2026-10-28T12:30:00+08:00")), false, "HK lunch break");
  assert.equal(inSession("hk", at("2026-10-28T16:05:00+08:00")), true, "closing auction");
  assert.equal(inSession("hk", at("2026-10-28T16:20:00+08:00")), true, "post-close window for 16:08–16:10 closing auction");
  assert.equal(inSession("hk", at("2026-10-28T16:40:00+08:00")), false, "after HK close");
  assert.equal(inSession("hk", at("2026-10-31T10:00:00+08:00")), false, "Saturday");
  assert.equal(inSession("domestic-futures", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("domestic-futures", at("2026-10-28T12:00:00+08:00")), false, "lunch break");
  assert.equal(inSession("domestic-futures", at("2026-10-28T14:30:00+08:00")), true, "afternoon session");
  assert.equal(inSession("domestic-futures", at("2026-10-31T10:00:00+08:00")), false, "Saturday");
  assert.equal(inSession("spot-daily", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("spot-daily", at("2026-10-28T22:00:00+08:00")), false, "night");
  assert.equal(inSession("spot-daily", at("2026-10-31T10:00:00+08:00")), false, "Saturday outside business hours");
  assert.equal(inSession("global", at("2026-10-28T03:00:00+08:00")), true);
  assert.equal(inSession("global", at("2026-10-31T06:50:00+08:00")), true, "Friday's New York session ends Saturday morning");
  assert.equal(inSession("global", at("2026-10-31T12:00:00+08:00")), false);
  assert.equal(inSession("global", at("2026-11-01T12:00:00+08:00")), false, "Sunday");
  assert.equal(inSession("global", at("2026-11-02T05:00:00+08:00")), false, "before Monday's open");
});

test("Sina, Tencent, Eastmoney, Yangzhu, MOA FarmDaily, and Zhue answers parse cleanly, and broken ones fail", () => {
  // 1. Sina global & domestic futures
  assert.deepEqual(
    parseKlines([
      { date: "2026-10-27", close: "109.670" },
      { date: "2026-10-28", close: "111.360" },
    ]),
    [
      { day: "2026-10-27", close: 109.67 },
      { day: "2026-10-28", close: 111.36 },
    ],
  );
  assert.deepEqual(
    parseKlines([
      { d: "2026-10-27", c: "9550" },
      { d: "2026-10-28", c: "9505" },
    ]),
    [
      { day: "2026-10-27", close: 9550 },
      { day: "2026-10-28", close: 9505 },
    ],
  );

  // 2. Tencent A-share/HK index
  assert.deepEqual(
    parseKlines({
      data: {
        hkHSTECH: {
          day: [
            ["2026-10-27", "3886.180", "3800.430", "3907.710", "3787.560", "37648593557.000"],
            ["2026-10-28", "3829.970", "3845.620", "3876.540", "3819.710", "38023308378.000"],
          ],
          qt: {
            hkHSTECH: ["100", "恒生科技指数", "HSTECH", "3853.720", ...Array(26).fill("0"), "2026/10/28 16:08:46"],
          },
        },
      },
    }),
    [
      { day: "2026-10-27", close: 3800.43 },
      { day: "2026-10-28", close: 3853.72 },
    ],
  );

  // 3. Eastmoney kline
  assert.deepEqual(
    parseKlines({
      data: {
        klines: [
          "2026-10-27,9700,9650,9750,9600,1000,1000000,1.5,1.0,100,0.0",
          "2026-10-28,9650,9500,9700,9450,1200,1200000,2.0,-1.5,-150,0.0",
        ],
      },
    }),
    [
      { day: "2026-10-27", close: 9650 },
      { day: "2026-10-28", close: 9500 },
    ],
  );

  // 4. Yangzhu hits data & daily hog-to-grain ratio calculation
  const hogHits = parseKlines({
    code: 200,
    data: [
      { pricedate: "2026-10-29", pigprice: "9.27" },
      { pricedate: "2026-10-30", pigprice: "9.19" },
    ],
  });
  const cornHits = parseKlines({
    code: 200,
    data: [
      { pricedate: "2026-10-29", maizeprice: 2340 },
      { pricedate: "2026-10-30", maizeprice: 2334 },
    ],
  });
  assert.deepEqual(computePigGrainSeries(hogHits, cornHits), [
    { day: "2026-10-29", close: 3.96 },
    { day: "2026-10-30", close: 3.94 },
  ]);

  // 5. MOA pfsc.agri.cn FarmDaily national wholesale pork reports
  assert.deepEqual(
    parseMoaFarmDailyPork({
      code: 200,
      content: {
        list: [
          {
            daylyDate: "2026-10-30 00:00:00",
            animalConclusion: "猪肉平均价格为15.29元/公斤，比昨天下降0.6%；牛肉73.44元/公斤。",
          },
          {
            daylyDate: "2026-10-29 00:00:00",
            animalConclusion: "猪肉平均价格为15.38元/公斤，比昨天下降1.3%。",
          },
        ],
      },
    }),
    [
      { day: "2026-10-29", close: 15.38 },
      { day: "2026-10-30", close: 15.29 },
    ],
  );

  // 6. Zhue pricecure reconstruction across year rollover + 15kg piglet multiplier + single-day spike filter
  const zhueParsed = parseZhuePriceCure(
    [
      {
        daystr: JSON.stringify(["12.30", "01.02", "01.05"]),
        datestr: "[{ name: '2027', data: [14.00,19.80,13.60],marker: {}},{ name: '2026', data: [20,20,20]}]",
      },
      {
        daystr: JSON.stringify(["12.31", "01.03", ""]),
        datestr: "[{ name: '2027', data: [13.90,13.70,null],marker: {}}]",
      },
      {
        daystr: JSON.stringify(["01.01", "01.04"]),
        datestr: "[{ name: '2027', data: [13.80,13.65],marker: {}}]",
      },
    ],
    { multiplier: 15 },
  );
  assert.equal(zhueParsed.length, 7);
  assert.equal(zhueParsed[0]!.day, "2026-12-30", "December dates before January wrap to previous year");
  assert.equal(zhueParsed[2]!.day, "2027-01-01");
  // 2027-01-02 had an isolated spike 19.80 between 13.80 and 13.70 -> despiked to 13.80 * 15 = 207
  const jan02 = zhueParsed.find((p) => p.day === "2027-01-02")!;
  assert.equal(jan02.close, 207);

  // Monotonic downward trend is untouched by despikeDailySeries
  const monotonic = [
    { day: "2026-10-26", close: 20 },
    { day: "2026-10-27", close: 17 },
    { day: "2026-10-28", close: 14 },
  ];
  assert.deepEqual(despikeDailySeries(monotonic), monotonic);

  // 7. Chinese period date formats
  assert.equal(normalizeDay("2026.10.30-农产品日报"), "2026-10-30");
  assert.equal(normalizeDay("2025年10月"), "2025-10-31");
  assert.equal(normalizeDay("2025年三季度（末）"), "2025-09-30");
  assert.equal(normalizeDay("2024"), "2024-12-31");

  assert.throws(() => parseKlines({ data: null }));
  assert.throws(() => parseKlines([]));
  assert.throws(() => parseKlines([{ date: "2026-10-28", close: "-" }]));
  assert.throws(() => parseMoaFarmDailyPork({ content: { list: [] } }));
});

test("each panel shows latest close, WoW/1m/2m changes, weekly trend series, unified benchmark, and converted RMB prices", async () => {
  const fetch: FetchCloses = async ({ symbol }) => {
    if (symbol === "sse" || symbol === "hstech") return closes(70, 150);
    if (symbol === "xau") return closes(70, 4000);
    if (symbol === "hog_futures") return closes(70, 9500);
    if (symbol === "corn_spot") return closes(70, 2334);
    if (symbol === "bean_spot") return closes(70, 3120);
    if (symbol === "hog_spot") return closes(70, 9.19);
    if (symbol === "pork_spot") return closes(70, 15.29);
    if (symbol === "piglet_spot") return closes(70, 205.05);
    if (symbol === "sow_spot") return closes(70, 1484.69);
    if (symbol === "pig_grain_ratio") return closes(70, 3.94);
    if (symbol === "sow_inventory") {
      return [
        { day: "2025-09-30", close: 4035 },
        { day: "2025-12-31", close: 4035 },
        { day: "2026-03-31", close: 3904 },
        { day: "2026-06-30", close: 3780 },
        { day: "2026-09-30", close: 3602 },
      ];
    }
    return closes(35, 110);
  };
  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), fetch, stubRate);
  const { quotes, usdCnyRate, analysis } = await readMarkets();

  assert.equal(usdCnyRate, 7.0);
  assert.deepEqual(quotes.map((q) => q.symbol), INSTRUMENTS.map((i) => i.symbol));

  // 1. Brent: USD, no CNY conversion, 35 days has 1w and 1m but no 2m baseline
  const brent = quotes.find((q) => q.symbol === "brent")!;
  assert.equal(brent.category, "macro");
  assert.equal(brent.price, 110);
  assert.equal(brent.cnyPrice, null);
  assert.equal(brent.close1w, 100 + 34 - 7);
  assert.ok(Math.abs(brent.change1w! - (110 / brent.close1w! - 1)) < 1e-9);
  assert.equal(brent.close1m, 100 + 34 - 30);
  assert.equal(brent.close2m, null);
  assert.equal(brent.benchmark, undefined, "macro quotes do not carry pork benchmarks");

  // 2. Gold: USD converted to CNY/gram
  const xau = quotes.find((q) => q.symbol === "xau")!;
  assert.ok(Math.abs(xau.cnyPrice! - (4000 * 7.0) / GRAMS_PER_TROY_OUNCE) < 1e-9);

  // 3. Hog spot: benchmark head loss matches rule-based analysis head loss identically
  const hogSpot = quotes.find((q) => q.symbol === "hog_spot")!;
  assert.equal(hogSpot.price, 9.19);
  assert.ok(hogSpot.weeklySeries && hogSpot.weeklySeries.length >= 9);
  assert.ok(hogSpot.benchmark);
  const expectedLoss = Math.abs(computeHogProfitMetrics(9.19).profitPerHead);
  assert.equal(expectedLoss, Math.abs(Math.round((9.19 - PORK_THRESHOLDS.hogFullCostPerKg) * PORK_THRESHOLDS.standardHogWeightKg)));
  assert.ok(hogSpot.benchmark.anchorSub?.includes(`¥${expectedLoss}`));
  assert.ok(analysis?.headline.includes(`¥${expectedLoss}`));

  // 4. Sow inventory: preserves all 5 quarterly points in series & weeklySeries
  const sowInv = quotes.find((q) => q.symbol === "sow_inventory")!;
  assert.equal(sowInv.series.length, 5);
  assert.deepEqual(
    sowInv.weeklySeries?.map((p) => p.label),
    ["25Q3", "25Q4", "26Q1", "26Q2", "26Q3"],
  );
  assert.equal(sowInv.benchmark?.statusBadge, "绿色区间去化");
});

test("unified pork benchmarks react dynamically to price & trend changes without static hardcoded conclusions", () => {
  const mk = (symbol: string, price: number, extra?: Partial<MarketQuote>): MarketQuote => ({
    symbol,
    name: symbol,
    category: "pork",
    currency: "CNY",
    unit: "公斤",
    cnyUnit: null,
    price,
    day: "2026-10-30",
    cnyPrice: null,
    closeYesterday: price,
    changeYesterday: 0,
    close1w: price,
    change1w: 0,
    close1m: price,
    change1m: 0,
    close2m: price,
    change2m: 0,
    series: [{ day: "2026-10-30", close: price }],
    ...extra,
  });

  // 1. Piglet: deep freeze (<240) vs normal profit (340) vs overheated (>450)
  const pigletFreeze = computePorkBenchmark(mk("piglet_spot", 205, { unit: "头", cnyPrice: 205 / 15 }), []);
  const pigletNormal = computePorkBenchmark(mk("piglet_spot", 340, { unit: "头", cnyPrice: 340 / 15 }), []);
  const pigletHot = computePorkBenchmark(mk("piglet_spot", 490, { unit: "头", cnyPrice: 490 / 15 }), []);
  assert.equal(pigletFreeze.statusBadge, "补栏冰点");
  assert.equal(pigletNormal.statusBadge, "补栏常态");
  assert.equal(pigletHot.statusBadge, "补栏过热");

  // 2. Breeding sow: deep discount vs equilibrium vs active expansion
  const sowLow = computePorkBenchmark(mk("sow_spot", 1320, { unit: "头", change1m: -0.15 }), []);
  const sowMid = computePorkBenchmark(mk("sow_spot", 1680, { unit: "头", change1m: 0.01 }), []);
  const sowHigh = computePorkBenchmark(mk("sow_spot", 1960, { unit: "头", change1m: 0.12 }), []);
  assert.equal(sowLow.statusBadge, "深跌去化");
  assert.equal(sowMid.statusBadge, "更新均衡");
  assert.equal(sowHigh.statusBadge, "扩繁活跃");
  assert.notEqual(sowLow.anchorText, sowMid.anchorText);

  // 3. Hog-to-grain ratio: deviation % is computed dynamically from actual price
  const ratio394 = computePorkBenchmark(mk("pig_grain_ratio", 3.94, { unit: ":1" }), []);
  const ratio450 = computePorkBenchmark(mk("pig_grain_ratio", 4.5, { unit: ":1" }), []);
  assert.ok(ratio394.anchorSub?.includes("-34.3%"));
  assert.ok(ratio450.anchorSub?.includes("-25.0%"));

  // 4. Feed cost (corn & soybean meal): reacts to 30-day trend
  const cornRising = computePorkBenchmark(mk("corn_spot", 2480, { unit: "吨", cnyPrice: 2.48, change1m: 0.06 }), []);
  const cornFalling = computePorkBenchmark(mk("corn_spot", 2180, { unit: "吨", cnyPrice: 2.18, change1m: -0.05 }), []);
  assert.equal(cornRising.statusBadge, "原料成本抬升");
  assert.equal(cornFalling.statusBadge, "原料让利回落");

  // 5. Weekly trend aggregation groups calendar weeks deterministically
  const weekly = buildWeeklyTrendSeries([
    { day: "2026-10-19", close: 10.0 }, // Mon
    { day: "2026-10-21", close: 9.6 },  // Wed -> week mean 9.8
    { day: "2026-10-26", close: 9.4 },  // Next Mon
    { day: "2026-10-30", close: 9.0 },  // Fri -> week mean 9.2
  ], "daily");
  assert.deepEqual(weekly, [
    { label: "10-21", close: 9.8 },
    { label: "10-30", close: 9.2 },
  ]);
});

test("today's close follows the latest price and a closed market is not read again", async () => {
  const read: string[] = [];
  let last = 150;
  const fetch: FetchCloses = async ({ symbol }) => (read.push(symbol), closes(45, last));
  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), fetch, stubRate);
  last = 151;
  read.length = 0;
  await refreshMarkets(new Date("2026-10-28T10:10:00+08:00"), fetch, stubRate);
  assert.deepEqual(read, INSTRUMENTS.map((i) => i.symbol));
  assert.equal((await readMarkets()).quotes.find((q) => q.symbol === "sse")!.price, 151);
  assert.equal(Number((await sql`SELECT count(*) FROM market_daily_closes WHERE symbol = 'sse'`)[0]!.count), 45, "one row per trading day");

  read.length = 0;
  await refreshMarkets(new Date("2026-10-31T12:00:00+08:00"), fetch, stubRate);
  assert.deepEqual(read, [], "Saturday noon: every market is closed");
});

test("one instrument failing leaves the others current, and the run reports it", async () => {
  const fetch: FetchCloses = async ({ symbol }) => {
    if (symbol === "xau") throw new Error("HTTP 502");
    return closes(45, 120);
  };
  await assert.rejects(refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), fetch, stubRate), /xau: HTTP 502/);
  const remaining = (await readMarkets()).quotes.map((q) => q.symbol);
  assert.equal(remaining.includes("xau"), false);
  assert.equal(remaining.includes("brent"), true);
  assert.equal(remaining.includes("hog_spot"), true);
});

test("daily closes older than half a year are pruned while quarterly capacity series keep multi-quarter history", async () => {
  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), async () => closes(200, 120), stubRate);
  const { marketCloses } = await pruneMarkets(new Date("2026-10-28T10:00:00+08:00"));
  const dailyInstrumentCount = INSTRUMENTS.filter((i) => i.session !== "spot-periodic").length;
  assert.equal(marketCloses, dailyInstrumentCount * 19);
  const sowCount = Number((await sql`SELECT count(*) FROM market_daily_closes WHERE symbol = 'sow_inventory'`)[0]!.count);
  assert.equal(sowCount, 200, "periodic capacity rows within 3 years are retained");
});

test("pork analysis provides cyclical stage, warning level, headline, and multi-dimensional assessments", async () => {
  const mockQuotes = [
    { symbol: "pig_grain_ratio", price: 3.94 },
    { symbol: "hog_spot", price: 9.19 },
    { symbol: "hog_futures", price: 9505, cnyPrice: 9.505 },
    { symbol: "pork_spot", price: 15.29 },
    { symbol: "piglet_spot", price: 205.05, unit: "头", cnyPrice: 13.67 },
    { symbol: "sow_spot", price: 1484.69, unit: "头" },
    { symbol: "sow_inventory", price: 3602 },
    { symbol: "corn_spot", price: 2334, cnyPrice: 2.334 },
    { symbol: "bean_spot", price: 3120, cnyPrice: 3.12 },
  ] as Parameters<typeof computeRuleBasedPorkAnalysis>[0];

  const analysis = computeRuleBasedPorkAnalysis(mockQuotes);
  assert.equal(analysis.warningLevel, "critical", "ratio < 5.0 triggers critical warning");
  assert.ok(analysis.stage.includes("深度亏损"));
  assert.ok(analysis.headline.includes("¥481"), "uses calibrated 13.20 CNY/kg * 120kg head loss");
  assert.ok(analysis.warningText.includes("过度下跌一级预警"));
  assert.equal(analysis.source, "rules");
  assert.equal(analysis.bullets.length, 4);

  const cautionAnalysis = computeRuleBasedPorkAnalysis([
    ...mockQuotes.filter((q) => q.symbol !== "pig_grain_ratio"),
    { symbol: "pig_grain_ratio", price: 5.5 } as (typeof mockQuotes)[0],
  ]);
  assert.equal(cautionAnalysis.warningLevel, "caution");

  const normalAnalysis = computeRuleBasedPorkAnalysis([
    ...mockQuotes.filter((q) => q.symbol !== "pig_grain_ratio"),
    { symbol: "pig_grain_ratio", price: 7.2 } as (typeof mockQuotes)[0],
  ]);
  assert.equal(normalAnalysis.warningLevel, "normal");

  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), async () => closes(45, 100), stubRate);
  const result = await readMarkets();
  assert.ok(result.analysis);
  assert.ok(result.analysis.stage);
  assert.ok(result.analysis.headline);
  assert.ok(result.analysis.bullets.length >= 3);
});

test("refreshPorkDaily runs at midnight Beijing time for all pork instruments, while refreshMacroMarkets only runs macro", async () => {
  const readSymbols: string[] = [];
  const fetch: FetchCloses = async ({ symbol }) => (readSymbols.push(symbol), closes(45, 100));

  const midnightBeijing = new Date("2026-10-29T00:00:00+08:00");
  await refreshPorkDaily(midnightBeijing, fetch);

  const porkSymbols = INSTRUMENTS.filter((i) => i.category === "pork").map((i) => i.symbol);
  const macroSymbols = INSTRUMENTS.filter((i) => i.category === "macro").map((i) => i.symbol);

  assert.deepEqual(readSymbols.sort(), porkSymbols.sort(), "pork daily only reads pork instruments");
  const storedPorkRows = await sql<{ symbol: string }[]>`SELECT DISTINCT symbol FROM market_daily_closes`;
  assert.deepEqual(storedPorkRows.map((r) => r.symbol).sort(), porkSymbols.sort());

  const [analysisRow] = await sql<{ value: { stage: string } }[]>`SELECT value FROM settings WHERE key = 'markets.pork_analysis'`;
  assert.ok(analysisRow?.value?.stage);

  readSymbols.length = 0;
  const intradayBeijing = new Date("2026-10-29T10:00:00+08:00");
  await refreshMacroMarkets(intradayBeijing, fetch, stubRate);

  assert.deepEqual(readSymbols.sort(), macroSymbols.sort(), "macro refresh only reads macro instruments");
});
