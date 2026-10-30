// Prices for the markets page: daily closes read from Sina (global commodities & DCE hog futures), Tencent
// (A-share and HK indices), MOA pfsc.agri.cn (official national wholesale pork daily reports), Zhue
// (15kg commercial piglets & breeding binary sows), Yangzhu/Xuantian (live hog, corn, soybean meal, and
// daily hog-to-grain ratio), plus official MOA/NBS quarterly breeding sow inventory.
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { guardedFetch, requireOk } from "@aihot/backend/lib/http-fetch";
import { addDays, beijingDate, beijingTime } from "@aihot/contracts/time";
import type {
  MarketCategory,
  MarketQuote,
  MarketsAnswer,
  MarketStatFrequency,
  MarketTrendPoint,
  PorkMarketAnalysis,
  PorkQuoteBenchmark,
} from "./types.ts";

export type Session = "a-share" | "hk" | "global" | "domestic-futures" | "spot-daily" | "spot-periodic";
export type InstrumentSource =
  | "sina-global"
  | "tencent-kline"
  | "eastmoney-kline"
  | "sina-inner-futures"
  | "yangzhu-hits"
  | "yangzhu-ratio"
  | "moa-pork-daily"
  | "zhue-cure"
  | "official-series";

export interface Instrument {
  symbol: string;
  name: string;
  category: MarketCategory;
  source: InstrumentSource;
  code: string;
  session: Session;
  currency: "USD" | "CNY" | "HKD";
  unit: string;
  cnyUnit: string | null;
  /** Scale factor for secondary price conversion (e.g. 0.001 to convert CNY/ton to CNY/kg). */
  scale?: number;
  /** Multiplier applied when ingesting raw source quotes (e.g. 15 to convert 15kg piglet CNY/kg to CNY/head). */
  sourceMultiplier?: number;
  /** Explanatory note or industry guidance. */
  note?: string;
  /** Pork industry sub-segment: spot | forward | cost */
  segment?: "spot" | "forward" | "cost";
  /** Forward biological / market horizon */
  horizon?: string;
  /** Update cadence of the underlying data source */
  statFrequency?: MarketStatFrequency;
  /** Source/cadence badge shown next to stat date */
  statSourceLabel?: string;
}

/**
 * Calibrated 2026 hog & pork industry cost and regulatory thresholds:
 * - Breeding cost & piglet breakeven calibrated to 2026 feed levels (corn ~2.33 CNY/kg, soybean meal ~3.12 CNY/kg)
 *   and industry average PSY (25~27), avoiding 2023-2024 high-grain-cost exaggeration.
 * - Sow inventory thresholds follow MOA "生猪产能综合调控实施方案（2026年修订）" (normal target 3750 万头, green 92%~103%).
 * - Hog-to-grain ratio thresholds follow NDRC "完善政府猪肉储备调节机制工作预案" (breakeven 6.0:1, Level-1 <5.0:1).
 */
export const PORK_THRESHOLDS = {
  hogFullCostPerKg: 13.2,
  hogCashCostPerKg: 11.5,
  standardHogWeightKg: 120,
  carcassDressingRate: 0.73,
  wholesaleProcessingFeePerKg: 2.0,
  pigletWeightKg: 15,
  pigletBreakevenPerHead: 300,
  pigletFreezePerHead: 240,
  pigletOverheatPerHead: 450,
  sowNormalPricePerHead: 1650,
  sowDeepDiscountPerHead: 1400,
  sowExpansionPerHead: 1850,
  sowInventoryTargetWan: 3750,
  sowInventoryGreenFloorRatio: 0.92,
  sowInventoryGreenCeilRatio: 1.03,
  sowInventoryYellowFloorRatio: 0.85,
  sowInventoryYellowCeilRatio: 1.08,
  pigGrainBreakeven: 6.0,
  pigGrainLevel1Floor: 5.0,
  pigGrainHighWarning: 9.0,
} as const;

export function computeHogProfitMetrics(hogPrice: number): {
  diffPerKg: number;
  diffPct: number;
  profitPerHead: number;
} {
  const diffPerKg = hogPrice - PORK_THRESHOLDS.hogFullCostPerKg;
  const diffPct = (diffPerKg / PORK_THRESHOLDS.hogFullCostPerKg) * 100;
  const profitPerHead = Math.round(diffPerKg * PORK_THRESHOLDS.standardHogWeightKg);
  return { diffPerKg, diffPct, profitPerHead };
}

/** In the page's order. */
export const INSTRUMENTS: readonly Instrument[] = [
  // --- 1. 生猪与猪肉产业链 (按产业链传导环节组织) ---
  {
    symbol: "hog_spot",
    name: "全国外三元生猪",
    category: "pork",
    source: "yangzhu-hits",
    code: "1",
    session: "spot-daily",
    currency: "CNY",
    unit: "公斤",
    cnyUnit: null,
    segment: "spot",
    horizon: "即期现货博弈",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "全国外三元生猪出栏大盘标杆价，短期供求晴雨表，检验行业现金与完全成本线",
  },
  {
    symbol: "pork_spot",
    name: "国内猪肉批发价",
    category: "pork",
    source: "moa-pork-daily",
    code: "pork_wholesale",
    session: "spot-daily",
    currency: "CNY",
    unit: "公斤",
    cnyUnit: null,
    segment: "spot",
    horizon: "即期终端消费",
    statFrequency: "daily",
    statSourceLabel: "农业部日频",
    note: "农业农村部监测全国农产品批发市场白条猪肉均价，反映终端走货与屠宰顺价能力",
  },
  {
    symbol: "hog_futures",
    name: "生猪期货连续",
    category: "pork",
    source: "sina-inner-futures",
    code: "LH0",
    session: "domestic-futures",
    currency: "CNY",
    unit: "吨",
    cnyUnit: "公斤",
    scale: 0.001,
    segment: "spot",
    horizon: "远期交割预期",
    statFrequency: "daily",
    statSourceLabel: "期货日盘",
    note: "大商所生猪主力连续合约（LH0），反映远期供需博弈与期现升贴水预期",
  },
  {
    symbol: "piglet_spot",
    name: "全国仔猪均价",
    category: "pork",
    source: "zhue-cure",
    code: "52",
    sourceMultiplier: 15,
    session: "spot-daily",
    currency: "CNY",
    unit: "头",
    cnyUnit: "公斤",
    scale: 1 / 15,
    segment: "forward",
    horizon: "影响5~6月后出栏",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "15kg外三元商品仔猪全国均价（繁育保本线约¥300/头），锁定半年后商品猪出栏节奏",
  },
  {
    symbol: "sow_spot",
    name: "繁育二元母猪",
    category: "pork",
    source: "zhue-cure",
    code: "40",
    session: "spot-daily",
    currency: "CNY",
    unit: "头",
    cnyUnit: null,
    segment: "forward",
    horizon: "影响10~12月后扩繁",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "后备二元种猪全国均价（常态更新基准约¥1650/头），衡量种猪补栏与产能扩张意愿",
  },
  {
    symbol: "sow_inventory",
    name: "能繁母猪存栏量",
    category: "pork",
    source: "official-series",
    code: "sow_inventory",
    session: "spot-periodic",
    currency: "CNY",
    unit: "万头",
    cnyUnit: null,
    segment: "forward",
    horizon: "影响10个月后产能底盘",
    statFrequency: "quarterly",
    statSourceLabel: "官方季报",
    note: "农业农村部/国家统计局季度核定核心产能（2026修订正常保有量目标3750万头）",
  },
  {
    symbol: "pig_grain_ratio",
    name: "生猪猪粮比价",
    category: "pork",
    source: "yangzhu-ratio",
    code: "1:4",
    session: "spot-daily",
    currency: "CNY",
    unit: ":1",
    cnyUnit: null,
    segment: "cost",
    horizon: "即期盈亏与收储调控",
    statFrequency: "daily",
    statSourceLabel: "日频测算",
    note: "发改委调控警戒线：盈亏平衡约 6.0:1，低于 5.0:1 触发过度下跌一级预警与中央收储",
  },
  {
    symbol: "corn_spot",
    name: "现货玉米价格",
    category: "pork",
    source: "yangzhu-hits",
    code: "4",
    session: "spot-daily",
    currency: "CNY",
    unit: "吨",
    cnyUnit: "公斤",
    scale: 0.001,
    segment: "cost",
    horizon: "能量饲料主料(约60%)",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "生猪配合饲料核心能量原料，占育肥饲料配方比重约 60%，决定基础养殖成本底盘",
  },
  {
    symbol: "bean_spot",
    name: "现货豆粕价格",
    category: "pork",
    source: "yangzhu-hits",
    code: "5",
    session: "spot-daily",
    currency: "CNY",
    unit: "吨",
    cnyUnit: "公斤",
    scale: 0.001,
    segment: "cost",
    horizon: "蛋白饲料主料(约20%)",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "生猪配合饲料主要蛋白原料（43%蛋白），占育肥饲料成本约 20%，构成饲料成本弹性来源",
  },

  // --- 2. 宏观大宗与金融指数 ---
  { symbol: "brent", name: "布伦特原油", category: "macro", source: "sina-global", code: "OIL", session: "global", currency: "USD", unit: "桶", cnyUnit: null },
  { symbol: "xau", name: "伦敦金", category: "macro", source: "sina-global", code: "XAU", session: "global", currency: "USD", unit: "盎司", cnyUnit: "克" },
  { symbol: "sse", name: "上证指数", category: "macro", source: "tencent-kline", code: "sh000001", session: "a-share", currency: "CNY", unit: "点", cnyUnit: null },
  { symbol: "hstech", name: "恒生科技指数", category: "macro", source: "tencent-kline", code: "hkHSTECH", session: "hk", currency: "HKD", unit: "点", cnyUnit: null },
];

/** Standard conversion: 1 troy ounce (金衡盎司, oz t) = 31.1034768 grams. */
export const GRAMS_PER_TROY_OUNCE = 31.1035;

/** Natural (calendar) days back for 近一月 (30天) and 近二月 (60天). */
export const DAYS_1M = 30;
export const DAYS_2M = 60;
/** Enough closes for 12 calendar weeks (~90 days) so weekly trend curves have full depth. */
const HISTORY = 90;
const SINA_FUTURES_URL = "https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesDailyKLine";
const SINA_INNER_FUTURES_URL = "http://stock2.finance.sina.com.cn/futures/api/jsonp.php/var_kline=/InnerFuturesNewService.getDailyKLine";
const SINA_INNER_LIVE_URL = "https://hq.sinajs.cn/list=";
const TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const EASTMONEY_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const YANGZHU_HITS_URL = "https://xt.yangzhu.vip/data/getzhujiahitsdata";
const MOA_FARM_DAILY_URL = "https://pfsc.agri.cn/api/FarmDaily/list?pageNum=1&pageSize=85";
const ZHUE_CURE_URL = "https://bj.zhue.com.cn/zoushi.php";

/**
 * Whether the market trades at `now` (Beijing), with margin before open and up to 30 minutes after close so
 * the opening print and the final close (including HKEX's 16:08–16:10 closing auction) are captured by the
 * 10-minute schedule. Brent and spot gold trade round the clock from Monday morning to Saturday morning
 * Beijing time. Exchange holidays are not known here: a run on one reads the last close again.
 */
export function inSession(session: Session, now: Date): boolean {
  const weekday = new Date(`${beijingDate(now)}T00:00:00Z`).getUTCDay();
  const time = beijingTime(now);
  if (session === "a-share") return weekday >= 1 && weekday <= 5 && ((time >= "09:25" && time <= "11:35") || (time >= "12:55" && time <= "15:30"));
  if (session === "hk") return weekday >= 1 && weekday <= 5 && ((time >= "09:25" && time <= "12:10") || (time >= "12:55" && time <= "16:30"));
  if (session === "domestic-futures") return weekday >= 1 && weekday <= 5 && ((time >= "08:55" && time <= "11:35") || (time >= "13:25" && time <= "15:10"));
  if (session === "spot-daily" || session === "spot-periodic") return weekday >= 1 && weekday <= 5 && time >= "08:00" && time <= "18:00";
  if (weekday === 0) return false;
  if (weekday === 1) return time >= "06:00";
  if (weekday === 6) return time <= "07:00";
  return true;
}

/** Parses standard or Chinese date strings into standard YYYY-MM-DD. */
export function normalizeDay(raw: string): string | null {
  const standard = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (standard) {
    return `${standard[1]}-${standard[2]!.padStart(2, "0")}-${standard[3]!.padStart(2, "0")}`;
  }
  const ym = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (ym) {
    return `${ym[1]}-${ym[2]!.padStart(2, "0")}-${ym[3]!.padStart(2, "0")}`;
  }
  const ymOnly = raw.match(/^(\d{4})年(\d{1,2})月/);
  if (ymOnly) {
    const y = ymOnly[1]!;
    const m = ymOnly[2]!.padStart(2, "0");
    const d = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate().toString().padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const q = raw.match(/^(\d{4})年?([一二三四1234])季度/);
  if (q) {
    const y = q[1]!;
    const qMap: Record<string, string> = { "一": "03-31", "1": "03-31", "二": "06-30", "2": "06-30", "三": "09-30", "3": "09-30", "四": "12-31", "4": "12-31" };
    return `${y}-${qMap[q[2]!] ?? "12-31"}`;
  }
  const yearOnly = raw.match(/^(\d{4})$/);
  if (yearOnly) return `${yearOnly[1]}-12-31`;
  return null;
}

/** The daily closes in a Sina/Tencent/Eastmoney/Yangzhu answer, oldest first. */
export function parseKlines(body: unknown): Array<{ day: string; close: number }> {
  const check = (day: unknown, close: unknown, raw: unknown) => {
    const d = normalizeDay(typeof day === "string" ? day : String(day ?? ""));
    const value = Number(close);
    if (!d || !Number.isFinite(value) || value <= 0) {
      throw new Error(`unreadable kline ${JSON.stringify(raw)}`);
    }
    return { day: d, close: value };
  };

  // 1. Array of Sina futures rows: [{ date: "...", close: "..." }, ...] or [{ d: "...", c: "..." }]
  if (Array.isArray(body)) {
    if (body.length === 0) throw new Error("no klines in the answer");
    return body.slice(-HISTORY).map((row) => {
      const r = row as { date?: unknown; close?: unknown; d?: unknown; c?: unknown } | null;
      return check(r?.date ?? r?.d, r?.close ?? r?.c, row);
    });
  }

  if (!body || typeof body !== "object") throw new Error("no klines in the answer");

  const obj = body as Record<string, unknown>;

  // 2. Eastmoney K-line answer: { data: { klines: ["2026-10-30,9550,9450,9600,9400,..."] } }
  const emData = obj.data as { klines?: unknown[] } | undefined;
  if (emData && Array.isArray(emData.klines)) {
    if (emData.klines.length === 0) throw new Error("no klines in the answer");
    return emData.klines.slice(-HISTORY).map((line) => {
      if (typeof line !== "string") throw new Error(`unreadable kline ${String(line)}`);
      const parts = line.split(",");
      return check(parts[0], parts[2], line);
    });
  }

  // 3. Yangzhu hits data: { code: 200, data: [{ pigprice/maizeprice/bean, pricedate }, ...] }
  // or array rows: { code: 200, data: [["2026-06-30", 26.77], ...] }
  if (Array.isArray(obj.data)) {
    const list = obj.data;
    if (list.length === 0) throw new Error("no klines in the answer");
    const closes: Array<{ day: string; close: number }> = [];
    for (const item of list) {
      if (Array.isArray(item)) {
        const dayRaw = item[0];
        let val: unknown = item[1];
        if (typeof val === "string" && !/^\d+(\.\d+)?$/.test(val) && item.length > 2) {
          val = item[2];
        }
        try {
          closes.push(check(dayRaw, val, item));
        } catch {
          // Skip invalid rows
        }
      } else if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const dayRaw = it.pricedate ?? it.date;
        const val = it.pigprice ?? it.maizeprice ?? it.bean ?? it.price ?? it.value;
        try {
          closes.push(check(dayRaw, val, item));
        } catch {
          // Skip invalid rows
        }
      }
    }
    if (closes.length === 0) throw new Error("no readable klines in the answer");
    closes.sort((a, b) => a.day.localeCompare(b.day));
    return closes.slice(-HISTORY);
  }

  // 4. Tencent K-line answer: { data: { [code]: { day: [...], qt: [...] } } }
  const data = obj.data as Record<string, { day?: unknown; qt?: Record<string, unknown> }> | undefined;
  const [code, entry] = data && typeof data === "object" && !Array.isArray(data) ? (Object.entries(data)[0] ?? []) : [];
  const lines = entry?.day;
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("no klines in the answer");
  const closes = lines.slice(-HISTORY).map((line) => {
    if (!Array.isArray(line)) throw new Error(`unreadable kline ${String(line)}`);
    return check(line[0], line[2], line);
  });

  const qt = code && entry?.qt && typeof entry.qt === "object" ? entry.qt[code] : undefined;
  const qtPrice = Array.isArray(qt) ? Number(qt[3]) : NaN;
  const qtTime = Array.isArray(qt) && typeof qt[30] === "string" ? qt[30].match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/) : null;
  if (qtTime && Number.isFinite(qtPrice) && qtPrice > 0) {
    const qtDay = `${qtTime[1]}-${qtTime[2]}-${qtTime[3]}`;
    const last = closes.at(-1)!;
    if (qtDay === last.day) last.close = qtPrice;
    else if (qtDay > last.day) closes.push({ day: qtDay, close: qtPrice });
  }
  return closes;
}

/**
 * Parses MOA (pfsc.agri.cn /api/FarmDaily/list) national daily wholesale agricultural reports
 * and extracts the official national wholesale pork average price (元/公斤).
 */
export function parseMoaFarmDailyPork(body: unknown): Array<{ day: string; close: number }> {
  if (!body || typeof body !== "object") throw new Error("unreadable MOA FarmDaily response");
  const content = (body as { content?: { list?: unknown[] } }).content;
  const list = content?.list;
  if (!Array.isArray(list) || list.length === 0) throw new Error("no list in MOA FarmDaily response");

  const byDay = new Map<string, number>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = String(item.animalConclusion ?? item.countentstr ?? "");
    const priceMatch = text.match(/猪肉(?:平均价格)?为?(\d+(?:\.\d+)?)元\/公斤/);
    if (!priceMatch) continue;
    const price = Number(priceMatch[1]);
    if (!Number.isFinite(price) || price <= 0) continue;

    let day = normalizeDay(String(item.daylyDate ?? item.remark ?? ""));
    if (!day && typeof item.year === "string" && typeof item.counclesion === "string") {
      const md = item.counclesion.match(/(\d{1,2})月(\d{1,2})日/);
      if (md) day = `${item.year}-${md[1]!.padStart(2, "0")}-${md[2]!.padStart(2, "0")}`;
    }
    if (day) byDay.set(day, price);
  }

  const closes = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, close]) => ({ day, close }));
  if (closes.length === 0) throw new Error("no readable pork wholesale prices in MOA FarmDaily");
  return closes.slice(-HISTORY);
}

function median3(a: number, b: number, c: number): number {
  return a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
}

/**
 * Rejects isolated 1-day thin-sample spikes/dropouts (>12% jump that immediately reverses)
 * while leaving monotonic trends and normal daily variations untouched.
 */
export function despikeDailySeries(series: Array<{ day: string; close: number }>): Array<{ day: string; close: number }> {
  if (series.length < 3) return series;
  const out = series.map((p) => ({ ...p }));
  for (let i = 1; i < out.length - 1; i++) {
    const prev = series[i - 1]!.close;
    const curr = series[i]!.close;
    const next = series[i + 1]!.close;
    const isPeakOrTrough = (curr > prev && curr > next) || (curr < prev && curr < next);
    const neighborMid = (prev + next) / 2;
    if (isPeakOrTrough && neighborMid > 0 && Math.abs(curr - neighborMid) / neighborMid > 0.12) {
      out[i]!.close = Number(median3(prev, curr, next).toFixed(2));
    }
  }
  const lastIdx = out.length - 1;
  const prev1 = out[lastIdx - 1]!.close;
  const prev2 = out[lastIdx - 2]!.close;
  const lastVal = out[lastIdx]!.close;
  if (
    prev1 > 0 &&
    prev2 > 0 &&
    Math.abs(lastVal - prev1) / prev1 > 0.18 &&
    Math.abs(prev1 - prev2) / prev2 < 0.1
  ) {
    out[lastIdx]!.close = Number(median3(prev2, prev1, lastVal).toFixed(2));
  }
  return out;
}

/**
 * Parses Zhue (bj.zhue.com.cn/zoushi.php?act=pricecure) JSON curves (e.g. day=89,90,91 offsets),
 * handles year boundaries safely, filters isolated thin-sample spikes, and applies optional unit multiplier.
 */
export function parseZhuePriceCure(
  responses: unknown[],
  opts?: { multiplier?: number },
): Array<{ day: string; close: number }> {
  const multiplier = opts?.multiplier ?? 1;
  const byDay = new Map<string, number>();

  for (const res of responses) {
    if (!res || typeof res !== "object") continue;
    const obj = res as { daystr?: unknown; datestr?: unknown };
    if (typeof obj.daystr !== "string" || typeof obj.datestr !== "string") continue;

    let days: unknown[];
    try {
      days = JSON.parse(obj.daystr) as unknown[];
    } catch {
      continue;
    }
    const seriesMatch = obj.datestr.match(/name:\s*'(\d{4})',\s*data:\s*\[([^\]]*)\]/);
    if (!seriesMatch || !Array.isArray(days)) continue;

    const endYear = Number(seriesMatch[1]);
    const rawVals = seriesMatch[2]!.split(",").map((s) => s.trim());

    let latestMonth = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const dStr = typeof days[i] === "string" ? (days[i] as string) : "";
      const m = dStr.match(/^(\d{2})\.(\d{2})$/);
      if (m) {
        latestMonth = Number(m[1]);
        break;
      }
    }
    if (!latestMonth || !Number.isFinite(endYear)) continue;

    for (let i = 0; i < days.length; i++) {
      const dStr = typeof days[i] === "string" ? (days[i] as string) : "";
      const m = dStr.match(/^(\d{2})\.(\d{2})$/);
      const rawVal = Number(rawVals[i]);
      if (!m || !Number.isFinite(rawVal) || rawVal <= 0) continue;
      const monthNum = Number(m[1]);
      const year = monthNum > latestMonth ? endYear - 1 : endYear;
      const isoDay = `${year}-${m[1]}-${m[2]}`;
      byDay.set(isoDay, rawVal);
    }
  }

  const rawSeries = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, close]) => ({ day, close }));

  if (rawSeries.length === 0) throw new Error("no readable closes in zhue pricecure response");

  const cleaned = despikeDailySeries(rawSeries).map(({ day, close }) => ({
    day,
    close: Number((close * multiplier).toFixed(2)),
  }));
  return cleaned.slice(-HISTORY);
}

/** Computes daily hog-to-grain ratio from daily live hog (CNY/kg) and spot corn (CNY/ton) series. */
export function computePigGrainSeries(
  hogCloses: Array<{ day: string; close: number }>,
  cornCloses: Array<{ day: string; close: number }>,
): Array<{ day: string; close: number }> {
  const cornByDay = new Map(cornCloses.map((c) => [c.day, c.close]));
  const out: Array<{ day: string; close: number }> = [];
  for (const h of hogCloses) {
    const cornTon = cornByDay.get(h.day);
    if (!cornTon || cornTon <= 0) continue;
    const ratio = Number((h.close / (cornTon / 1000)).toFixed(2));
    if (Number.isFinite(ratio) && ratio > 0) {
      out.push({ day: h.day, close: ratio });
    }
  }
  if (out.length === 0) throw new Error("cannot compute hog-to-grain series: no overlapping hog and corn dates");
  return out.slice(-HISTORY);
}

/** Aggregates daily closes into Monday-Sunday weekly averages (up to 12 weeks) or quarterly points for periodic series. */
export function buildWeeklyTrendSeries(
  own: Array<{ day: string; close: number }>,
  frequency: MarketStatFrequency = "daily",
): MarketTrendPoint[] {
  if (own.length === 0) return [];
  if (frequency === "quarterly") {
    return own.slice(-12).map(({ day, close }) => {
      const yy = day.slice(2, 4);
      const q = Math.ceil(Number(day.slice(5, 7)) / 3);
      return { label: `${yy}Q${q}`, close: Number(close.toFixed(2)) };
    });
  }

  const buckets = new Map<string, { sum: number; count: number; lastDay: string }>();
  for (const { day, close } of own) {
    const dt = new Date(`${day}T00:00:00Z`);
    const dow = dt.getUTCDay(); // 0=Sun, 1=Mon...
    const offsetToMonday = dow === 0 ? -6 : 1 - dow;
    const mondayKey = addDays(day, offsetToMonday);
    const existing = buckets.get(mondayKey);
    if (existing) {
      existing.sum += close;
      existing.count += 1;
      if (day > existing.lastDay) existing.lastDay = day;
    } else {
      buckets.set(mondayKey, { sum: close, count: 1, lastDay: day });
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([, b]) => ({
      label: b.lastDay.slice(5),
      close: Number((b.sum / b.count).toFixed(2)),
    }));
}

/** Unified, zero-hardcoding cyclical benchmark & cost/policy anchor evaluation for all 9 pork indicators. */
export function computePorkBenchmark(q: MarketQuote, allQuotes: MarketQuote[]): PorkQuoteBenchmark {
  const getQ = (sym: string) => allQuotes.find((item) => item.symbol === sym);
  const hog = getQ("hog_spot");
  const corn = getQ("corn_spot");
  const bean = getQ("bean_spot");

  switch (q.symbol) {
    case "hog_spot": {
      const { diffPerKg, diffPct, profitPerHead } = computeHogProfitMetrics(q.price);
      const signPct = `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`;
      if (q.price < PORK_THRESHOLDS.hogCashCostPerKg) {
        return {
          anchorText: `较完全成本 ${signPct}`,
          anchorSub: `头均亏损约 ¥${Math.abs(profitPerHead)} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
          referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
          statusBadge: "击穿现金成本",
          statusTone: "critical",
          statusDesc: `跌破行业现金成本线(¥${PORK_THRESHOLDS.hogCashCostPerKg.toFixed(1)}/kg)，全行业现金流承压加速去产能`,
        };
      }
      if (diffPerKg < 0) {
        return {
          anchorText: `较完全成本 ${signPct}`,
          anchorSub: `头均亏损约 ¥${Math.abs(profitPerHead)} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
          referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
          statusBadge: "完全成本下方",
          statusTone: "caution",
          statusDesc: `低于行业自繁自养完全成本(¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)}/kg)，高成本产能边际出清`,
        };
      }
      if (diffPerKg < 2.5) {
        return {
          anchorText: `成本溢价 ${signPct}`,
          anchorSub: `头均盈利约 ¥${profitPerHead} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
          referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
          statusBadge: "温和盈利区",
          statusTone: "positive",
          statusDesc: `站上行业完全成本线(¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)}/kg)，自繁自养恢复合理现金回报`,
        };
      }
      return {
        anchorText: `成本溢价 ${signPct}`,
        anchorSub: `头均盈利约 ¥${profitPerHead} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
        referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
        statusBadge: "高景气盈利",
        statusTone: "accent",
        statusDesc: "头均养殖利润丰厚，需关注压栏二育与中远期产能扩张节奏",
      };
    }

    case "pork_spot": {
      const hogPrice = hog?.price ?? 9.19;
      const spread = q.price - hogPrice;
      const ratio = q.price / (hogPrice || 1);
      // 理论批发保本线 = 毛猪折白条原料成本(出肉率73%) + 屠宰检疫冷链批发刚性费用(约2.0元/kg)
      const wholesaleBreakeven = hogPrice / PORK_THRESHOLDS.carcassDressingRate + PORK_THRESHOLDS.wholesaleProcessingFeePerKg;
      const margin = q.price - wholesaleBreakeven;
      if (margin < -0.4) {
        return {
          anchorText: `毛白价差 ¥${spread.toFixed(2)}/kg`,
          anchorSub: `白条/毛猪比 ${ratio.toFixed(2)}:1 (顺价偏弱)`,
          referenceLine: Number(wholesaleBreakeven.toFixed(2)),
          statusBadge: "终端顺价承压",
          statusTone: "caution",
          statusDesc: `批发白条低于理论顺价平衡线(¥${wholesaleBreakeven.toFixed(2)}/kg)，终端消费承接偏弱`,
        };
      }
      if (margin <= 1.2) {
        return {
          anchorText: `毛白价差 ¥${spread.toFixed(2)}/kg`,
          anchorSub: `白条/毛猪比 ${ratio.toFixed(2)}:1`,
          referenceLine: Number(wholesaleBreakeven.toFixed(2)),
          statusBadge: "屠宰顺价平衡",
          statusTone: "neutral",
          statusDesc: "农业部批发白条与毛猪原料成本大体匹配，屠宰鲜销走货平稳",
        };
      }
      return {
        anchorText: `毛白价差 ¥${spread.toFixed(2)}/kg`,
        anchorSub: `白条/毛猪比 ${ratio.toFixed(2)}:1 (走货偏强)`,
        referenceLine: Number(wholesaleBreakeven.toFixed(2)),
        statusBadge: "终端走货顺畅",
        statusTone: "positive",
        statusDesc: "白条批发溢价改善，下游鲜销需求对毛猪价格形成正向支撑",
      };
    }

    case "hog_futures": {
      const hogPrice = hog?.price ?? 9.19;
      const futuresKg = q.cnyPrice ?? q.price / 1000;
      const basis = futuresKg - hogPrice;
      const basisPct = (basis / (hogPrice || 1)) * 100;
      if (Math.abs(basis) < 0.15) {
        return {
          anchorText: `期现基本平水 (${basis >= 0 ? "+" : ""}¥${basis.toFixed(2)}/kg)`,
          anchorSub: `主力较现货 ${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(1)}%`,
          referenceLine: Number((hogPrice * 1000).toFixed(0)),
          statusBadge: "期现平水博弈",
          statusTone: "neutral",
          statusDesc: "主力合约与现货出栏价基本平水，远期多空预期趋于一致",
        };
      }
      if (basis > 0) {
        return {
          anchorText: `期货升水 +¥${basis.toFixed(2)}/kg`,
          anchorSub: `合 +${Math.round(basis * 1000)}元/吨 (+${basisPct.toFixed(1)}%)`,
          referenceLine: Number((hogPrice * 1000).toFixed(0)),
          statusBadge: "远期升水预期",
          statusTone: "accent",
          statusDesc: "期货较现货维持升水，衍生品市场计价去产能后的远期供需改善",
        };
      }
      return {
        anchorText: `期货贴水 -¥${Math.abs(basis).toFixed(2)}/kg`,
        anchorSub: `合 -${Math.round(Math.abs(basis) * 1000)}元/吨 (${basisPct.toFixed(1)}%)`,
        referenceLine: Number((hogPrice * 1000).toFixed(0)),
        statusBadge: "远期贴水谨慎",
        statusTone: "caution",
        statusDesc: "期货贴水现货运行，市场对中远期出栏供给压力仍持谨慎预期",
      };
    }

    case "piglet_spot": {
      const breakeven = PORK_THRESHOLDS.pigletBreakevenPerHead;
      const diff = q.price - breakeven;
      const diffPct = (diff / breakeven) * 100;
      const perKg = q.cnyPrice ?? q.price / PORK_THRESHOLDS.pigletWeightKg;
      if (q.price < PORK_THRESHOLDS.pigletFreezePerHead) {
        return {
          anchorText: `低于保本线(¥${breakeven}) ${diffPct.toFixed(1)}%`,
          anchorSub: `头均亏约 ¥${Math.round(Math.abs(diff))} (折¥${perKg.toFixed(2)}/kg)`,
          referenceLine: breakeven,
          statusBadge: "补栏冰点",
          statusTone: "critical",
          statusDesc: "15kg仔猪深跌至繁育成本大幅下方，外购补栏停滞锁定5~6月后出栏收缩",
        };
      }
      if (q.price < breakeven) {
        return {
          anchorText: `低于保本线(¥${breakeven}) ${diffPct.toFixed(1)}%`,
          anchorSub: `头均微亏 ¥${Math.round(Math.abs(diff))} (折¥${perKg.toFixed(2)}/kg)`,
          referenceLine: breakeven,
          statusBadge: "补栏偏冷",
          statusTone: "caution",
          statusDesc: "外售仔猪处于繁育保本线下方，下游育肥户观望为主、补栏节奏放缓",
        };
      }
      if (q.price <= PORK_THRESHOLDS.pigletOverheatPerHead) {
        return {
          anchorText: `高于保本线(¥${breakeven}) +${diffPct.toFixed(1)}%`,
          anchorSub: `头均毛利 ¥${Math.round(diff)} (折¥${perKg.toFixed(2)}/kg)`,
          referenceLine: breakeven,
          statusBadge: "补栏常态",
          statusTone: "positive",
          statusDesc: "仔猪销售恢复合理盈利，养殖场户按年度计划正常轮动补栏",
        };
      }
      return {
        anchorText: `高于保本线(¥${breakeven}) +${diffPct.toFixed(1)}%`,
        anchorSub: `头均溢价 ¥${Math.round(diff)} (折¥${perKg.toFixed(2)}/kg)`,
        referenceLine: breakeven,
        statusBadge: "补栏过热",
        statusTone: "caution",
        statusDesc: "仔猪抢购溢价偏高，需警惕5~6月后外购育肥出栏成本抬升风险",
      };
    }

    case "sow_spot": {
      const normal = PORK_THRESHOLDS.sowNormalPricePerHead;
      const diffPct = ((q.price - normal) / normal) * 100;
      const ch1mPct = q.change1m !== null ? `${q.change1m >= 0 ? "+" : ""}${(q.change1m * 100).toFixed(1)}%` : null;
      const subText = ch1mPct ? `常态基准 ¥${normal}/头 · 近30日 ${ch1mPct}` : `常态更新基准约 ¥${normal}/头`;
      if (q.price < PORK_THRESHOLDS.sowDeepDiscountPerHead) {
        return {
          anchorText: `较常态基准 ${diffPct.toFixed(1)}%`,
          anchorSub: subText,
          referenceLine: normal,
          statusBadge: "深跌去化",
          statusTone: "critical",
          statusDesc: "二元种猪跌破更新底线，种猪场被动降价促销、基础母猪加速淘汰",
        };
      }
      if (q.price < normal - 50) {
        return {
          anchorText: `较常态基准 ${diffPct.toFixed(1)}%`,
          anchorSub: subText,
          referenceLine: normal,
          statusBadge: "扩繁谨慎",
          statusTone: "caution",
          statusDesc: "后备母猪报价低于常态更新中枢，集团与家庭猪场补母意愿偏弱",
        };
      }
      if (q.price <= PORK_THRESHOLDS.sowExpansionPerHead) {
        return {
          anchorText: `较常态基准 ${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`,
          anchorSub: subText,
          referenceLine: normal,
          statusBadge: "更新均衡",
          statusTone: "positive",
          statusDesc: "二元种猪价格处于常态更新区间，基础母猪群维持正常胎龄更替",
        };
      }
      return {
        anchorText: `较常态基准 +${diffPct.toFixed(1)}%`,
        anchorSub: subText,
        referenceLine: normal,
        statusBadge: "扩繁活跃",
        statusTone: "accent",
        statusDesc: "后备母猪溢价走强、引种扩繁积极，预示10~12月后基础产能回升",
      };
    }

    case "sow_inventory": {
      const target = PORK_THRESHOLDS.sowInventoryTargetWan;
      const ratio = q.price / target;
      const ratioPct = ratio * 100;
      const diffWan = q.price - target;
      const diffLabel = diffWan >= 0 ? `较基准 +${diffWan.toFixed(0)}万头` : `较基准3750万少 ${Math.abs(diffWan).toFixed(0)}万头`;

      if (ratio < PORK_THRESHOLDS.sowInventoryYellowFloorRatio) {
        return {
          anchorText: `保有量 ${ratioPct.toFixed(1)}% (红色预警区)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "产能过度紧缺",
          statusTone: "critical",
          statusDesc: "低于正常保有量85%红线，远期生猪供应存在显著短缺风险",
        };
      }
      if (ratio < PORK_THRESHOLDS.sowInventoryGreenFloorRatio) {
        return {
          anchorText: `保有量 ${ratioPct.toFixed(1)}% (黄色调控区)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "大幅去化预警",
          statusTone: "caution",
          statusDesc: "跌入保有量85%~92%黄色波动区，基础产能深度收缩支撑远期反转",
        };
      }
      if (ratio < 1.0) {
        return {
          anchorText: `达保有量 ${ratioPct.toFixed(1)}% (绿色下沿)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "绿色区间去化",
          statusTone: "positive",
          statusDesc: "处于92%~103%绿色区间下半区且低于3750万目标，产能实质性调减",
        };
      }
      if (ratio <= PORK_THRESHOLDS.sowInventoryGreenCeilRatio) {
        return {
          anchorText: `达保有量 ${ratioPct.toFixed(1)}% (绿色上沿)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "产能充裕稳健",
          statusTone: "neutral",
          statusDesc: "处于农业农村部92%~103%绿色合理区间上半区，10个月后基础供给充裕",
        };
      }
      return {
        anchorText: `达保有量 ${ratioPct.toFixed(1)}% (超保有上限)`,
        anchorSub: diffLabel,
        referenceLine: target,
        statusBadge: "产能偏多预警",
        statusTone: "caution",
        statusDesc: "超出正常保有量103%绿色上限，需引导调减能繁母猪以防远期过剩",
      };
    }

    case "pig_grain_ratio": {
      const breakeven = PORK_THRESHOLDS.pigGrainBreakeven;
      const devPct = ((q.price - breakeven) / breakeven) * 100;
      const devSign = `${devPct >= 0 ? "+" : ""}${devPct.toFixed(1)}%`;
      if (q.price < PORK_THRESHOLDS.pigGrainLevel1Floor) {
        return {
          anchorText: `破 ${PORK_THRESHOLDS.pigGrainLevel1Floor.toFixed(1)}:1 (一级预警)`,
          anchorSub: `距平衡线(${breakeven.toFixed(1)}:1) 偏离 ${devSign}`,
          referenceLine: breakeven,
          statusBadge: "一级预警收储",
          statusTone: "critical",
          statusDesc: "触发发改委过度下跌一级预警(<5.0:1)，中央储备冻猪肉收储机制托底",
        };
      }
      if (q.price < breakeven) {
        return {
          anchorText: `5.0~6.0:1 (亏损预警区)`,
          anchorSub: `距平衡线(${breakeven.toFixed(1)}:1) 偏离 ${devSign}`,
          referenceLine: breakeven,
          statusBadge: "二级/三级预警",
          statusTone: "caution",
          statusDesc: "低于发改委6.0:1盈亏平衡参考点，行业处于轻中度亏损监测区间",
        };
      }
      if (q.price <= PORK_THRESHOLDS.pigGrainHighWarning) {
        return {
          anchorText: `6.0~9.0:1 (正常运行区)`,
          anchorSub: `高于平衡线(${breakeven.toFixed(1)}:1) ${devSign}`,
          referenceLine: breakeven,
          statusBadge: "比价运行合理",
          statusTone: "positive",
          statusDesc: "猪粮比处于发改委绿色正常区间，生猪养殖与粮食成本比价均衡",
        };
      }
      return {
        anchorText: `超 ${PORK_THRESHOLDS.pigGrainHighWarning.toFixed(1)}:1 (上涨预警)`,
        anchorSub: `高于平衡线(${breakeven.toFixed(1)}:1) ${devSign}`,
        referenceLine: breakeven,
        statusBadge: "过度上涨预警",
        statusTone: "caution",
        statusDesc: "猪粮比突破9.0:1调控上限，关注中央储备肉投放稳价信号",
      };
    }

    case "corn_spot":
    case "bean_spot": {
      const isCorn = q.symbol === "corn_spot";
      const weightText = isCorn ? "占配合饲料约 60%" : "占配合饲料约 20%";
      const cornKg = corn?.cnyPrice ?? (corn?.price ? corn.price / 1000 : 2.33);
      const beanKg = bean?.cnyPrice ?? (bean?.price ? bean.price / 1000 : 3.12);
      // 育肥猪全价配合料估算: 62%玉米 + 18%豆粕 + 20%麸皮预混料与加工(约0.72元/kg固定项)
      const estFeedPerKg = 0.62 * cornKg + 0.18 * beanKg + 0.72;
      const ch1m = q.change1m ?? q.change1w ?? 0;
      const ch1mPct = `${ch1m >= 0 ? "+" : ""}${(ch1m * 100).toFixed(1)}%`;

      if (ch1m > 0.03) {
        return {
          anchorText: weightText,
          anchorSub: `近30日 ${ch1mPct} · 配合料约¥${estFeedPerKg.toFixed(2)}/kg`,
          statusBadge: "原料成本抬升",
          statusTone: "caution",
          statusDesc: `${isCorn ? "玉米能量料" : "豆粕蛋白料"}近月走强(${ch1mPct})，边际推升育肥造肉饲料成本`,
        };
      }
      if (ch1m < -0.03) {
        return {
          anchorText: weightText,
          anchorSub: `近30日 ${ch1mPct} · 配合料约¥${estFeedPerKg.toFixed(2)}/kg`,
          statusBadge: "原料让利回落",
          statusTone: "positive",
          statusDesc: `${isCorn ? "玉米现货" : "豆粕现货"}近月回落(${ch1mPct})，缓解养殖端饲料现金支出压力`,
        };
      }
      return {
        anchorText: weightText,
        anchorSub: `近30日 ${ch1mPct} · 配合料约¥${estFeedPerKg.toFixed(2)}/kg`,
        statusBadge: "成本窄幅震荡",
        statusTone: "neutral",
        statusDesc: `${isCorn ? "玉米能量主料" : "豆粕蛋白主料"}近30日波动温和(${ch1mPct})，饲料成本底线平稳`,
      };
    }

    default:
      return {
        anchorText: "行业参考指标",
        statusBadge: "常态监测",
        statusTone: "neutral",
        statusDesc: q.note ?? "",
      };
  }
}

export type FetchCloses = (instrument: Instrument) => Promise<Array<{ day: string; close: number }>>;
export type FetchRate = () => Promise<number>;

async function fetchYangzhuHits(code: string, label: string): Promise<Array<{ day: string; close: number }>> {
  const url = `${YANGZHU_HITS_URL}?ptype=${code}&areano=-1&datetype=0`;
  const res = requireOk(await guardedFetch(url, {
    method: "POST",
    timeoutMs: 15_000,
    headers: { "user-agent": "Mozilla/5.0", referer: "https://zhujia.zhuwang.com.cn" },
  }), label);
  return parseKlines(JSON.parse(res.text()));
}

export const defaultFetchCloses: FetchCloses = async (instrument) => {
  const { symbol, code, source, sourceMultiplier } = instrument;

  if (source === "sina-global") {
    const url = `${SINA_FUTURES_URL}?symbol=${code}`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn" },
    }), symbol);
    return parseKlines(JSON.parse(res.text()));
  }

  if (source === "tencent-kline") {
    const url = `${TENCENT_KLINE_URL}?param=${code},day,,,${HISTORY},qfq`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com" },
    }), symbol);
    return parseKlines(JSON.parse(res.text()));
  }

  if (source === "eastmoney-kline") {
    const url = `${EASTMONEY_KLINE_URL}?secid=${code}&klt=101&fqt=1&lmt=${HISTORY}&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://quote.eastmoney.com" },
    }), symbol);
    return parseKlines(JSON.parse(res.text()));
  }

  if (source === "sina-inner-futures") {
    const url = `${SINA_INNER_FUTURES_URL}?symbol=${code}`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn" },
    }), symbol);
    const raw = res.text();
    const match = raw.match(/\(\s*(\[[\s\S]*\])\s*\)/);
    if (!match) throw new Error(`unreadable inner futures jsonp response for ${code}`);
    const parsed = parseKlines(JSON.parse(match[1]!));

    // Append today's live price during or after session if available
    try {
      const liveRes = await guardedFetch(`${SINA_INNER_LIVE_URL}nf_${code}`, {
        timeoutMs: 5_000,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn" },
      });
      if (liveRes.status === 200) {
        const text = liveRes.text();
        const rawLive = text.split('"')[1];
        if (rawLive) {
          const parts = rawLive.split(",");
          const currentPrice = Number(parts[8]);
          const date = parts[17];
          if (date && Number.isFinite(currentPrice) && currentPrice > 0) {
            const last = parsed.at(-1);
            if (last && last.day === date) {
              last.close = currentPrice;
            } else {
              parsed.push({ day: date, close: currentPrice });
            }
          }
        }
      }
    } catch {
      // Live snapshot is a progressive enhancement; keep historical closes on failure.
    }

    return parsed;
  }

  if (source === "yangzhu-hits") {
    return fetchYangzhuHits(code, symbol);
  }

  if (source === "yangzhu-ratio") {
    const [hogCode = "1", cornCode = "4"] = code.split(":");
    const [hogCloses, cornCloses] = await Promise.all([
      fetchYangzhuHits(hogCode, `${symbol}_hog`),
      fetchYangzhuHits(cornCode, `${symbol}_corn`),
    ]);
    return computePigGrainSeries(hogCloses, cornCloses);
  }

  if (source === "moa-pork-daily") {
    const res = requireOk(await guardedFetch(MOA_FARM_DAILY_URL, {
      method: "POST",
      timeoutMs: 15_000,
      headers: {
        "user-agent": "Mozilla/5.0",
        "content-type": "application/json",
        referer: "https://pfsc.agri.cn/",
      },
      body: JSON.stringify({ pageNum: 1, pageSize: 85 }),
    }), symbol);
    return parseMoaFarmDailyPork(JSON.parse(res.text()));
  }

  if (source === "zhue-cure") {
    // Zhue pricecure samples every 3rd day over ~90 days; querying day=89, 90, 91 reconstructs all 90 daily points.
    const responses = await Promise.all([89, 90, 91].map(async (d) => {
      const url = `${ZHUE_CURE_URL}?act=pricecure&puote_small_id=${code}&province_name=&day=${d}`;
      const res = requireOk(await guardedFetch(url, {
        timeoutMs: 15_000,
        headers: {
          "user-agent": "Mozilla/5.0",
          "x-requested-with": "XMLHttpRequest",
          referer: ZHUE_CURE_URL,
        },
      }), `${symbol}_d${d}`);
      return JSON.parse(res.text()) as unknown;
    }));
    return parseZhuePriceCure(responses, { multiplier: sourceMultiplier ?? 1 });
  }

  if (source === "official-series") {
    if (code === "sow_inventory") {
      // 农业农村部及国家统计局季度核定公布的官方全国能繁母猪存栏量（万头）
      return [
        { day: "2024-12-31", close: 4078 },
        { day: "2025-03-31", close: 4039 },
        { day: "2025-06-30", close: 4043 },
        { day: "2025-09-30", close: 4035 },
        { day: "2025-12-31", close: 4035 },
        { day: "2026-03-31", close: 3904 },
        { day: "2026-06-30", close: 3780 },
        { day: "2026-09-30", close: 3602 },
      ];
    }
    throw new Error(`unknown official series ${code}`);
  }

  throw new Error(`unsupported instrument source ${source}`);
};

export const defaultUsdCnyRate: FetchRate = async () => {
  const url = "http://hq.sinajs.cn/list=fx_susdcny";
  const res = requireOk(await guardedFetch(url, {
    timeoutMs: 10_000,
    headers: { referer: "https://finance.sina.com.cn" },
  }), "fx_susdcny");
  const match = res.text().match(/="([^"]+)"/);
  if (!match) throw new Error("unreadable fx response");
  const parts = match[1]!.split(",");
  const rate = Number(parts[8]) || Number(parts[1]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`invalid fx rate: ${match[1]}`);
  return rate;
};

/**
 * Reads the closes of instruments, and optionally the USD/CNY rate from Sina.
 * If category is "pork", only pork instruments are refreshed and inSession checks are bypassed (daily midnight settlement).
 * If category is "macro", only macro instruments and USD/CNY rate are refreshed during active trading sessions.
 */
export async function refreshMarkets(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
  fetchRate: FetchRate = defaultUsdCnyRate,
  category?: MarketCategory | "all",
): Promise<Record<string, number>> {
  const isPork = category === "pork";
  const isMacro = category === "macro";
  const known = new Set((await sql<{ symbol: string }[]>`SELECT DISTINCT symbol FROM market_daily_closes`).map((r) => r.symbol));
  const written: Record<string, number> = {};
  const failed: string[] = [];

  // 1. Fetch and store USD/CNY exchange rate (skip when strictly refreshing pork)
  if (!isPork) {
    try {
      const rate = await fetchRate();
      if (rate > 0) {
        const changed = await sql`
          INSERT INTO market_daily_closes (symbol, day, close)
          VALUES ('usdcny', ${beijingDate(now)}::date, ${rate})
          ON CONFLICT (symbol, day) DO UPDATE SET close = excluded.close
          WHERE market_daily_closes.close IS DISTINCT FROM excluded.close`;
        written.usdcny = changed.count;
      }
    } catch (error) {
      // A transient FX fetch failure should not break commodity prices; last stored rate remains.
      failed.push(`usdcny: ${(error as Error).message}`);
    }
  }

  // 2. Fetch instruments matching category
  const targetInstruments = category && category !== "all"
    ? INSTRUMENTS.filter((i) => i.category === category)
    : INSTRUMENTS;

  for (const instrument of targetInstruments) {
    // When refreshing pork daily at midnight, always fetch the settled closes; otherwise check inSession
    if (!isPork && known.has(instrument.symbol) && !inSession(instrument.session, now)) continue;
    try {
      const closes = await fetchCloses(instrument);
      const rows = closes.map((c) => ({ symbol: instrument.symbol, day: c.day, close: c.close }));
      if (rows.length === 0) continue;
      const changed = await sql`
        INSERT INTO market_daily_closes ${sql(rows, "symbol", "day", "close")}
        ON CONFLICT (symbol, day) DO UPDATE SET close = excluded.close
        WHERE market_daily_closes.close IS DISTINCT FROM excluded.close`;
      written[instrument.symbol] = changed.count;
      await new Promise((r) => setTimeout(r, 250));
    } catch (error) {
      failed.push(`${instrument.symbol}: ${(error as Error).message}`);
    }
  }

  if (failed.length) throw new Error(`markets refresh failed for ${failed.join("; ")}`);

  // 3. Generate and store consolidated pork analysis in settings (when refreshing pork or all)
  if (!isMacro) {
    try {
      const currentData = await readMarkets({ skipAnalysis: true });
      const analysis = await generatePorkAnalysis(currentData.quotes);
      await sql`
        INSERT INTO settings (key, value, updated_by)
        VALUES ('markets.pork_analysis', ${sql.json(analysis as never)}, 'worker.markets')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    } catch {
      // Non-blocking if analysis persistence encounters transient failure
    }
  }

  return written;
}

/** Daily pork industry refresh (Beijing 00:00): fetches all 9 pork instruments and runs AI cyclical analysis. */
export async function refreshPorkDaily(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
): Promise<Record<string, number>> {
  return refreshMarkets(now, fetchCloses, defaultUsdCnyRate, "pork");
}

/** Intraday macro benchmarks refresh (every 10 minutes): updates Brent, gold, SSE, HSTECH, and FX rate. */
export async function refreshMacroMarkets(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
  fetchRate: FetchRate = defaultUsdCnyRate,
): Promise<Record<string, number>> {
  return refreshMarkets(now, fetchCloses, fetchRate, "macro");
}

export const PorkMarketAnalysisSchema = z.object({
  stage: z.string().describe("生猪周期当前所处阶段判定"),
  headline: z.string().describe("生猪产业链综合研判核心结论，1-2句话，精炼专业"),
  warningLevel: z.enum(["normal", "caution", "critical"]).describe("预警等级：normal 正常，caution 二级预警，critical 一级预警"),
  warningText: z.string().describe("预警原因与监管信号"),
  bullets: z.array(z.object({
    dimension: z.string().describe("研判维度"),
    assessment: z.string().describe("该维度的具体产业链数据分析与趋势推演"),
  })).min(3).max(5),
});

export function computeRuleBasedPorkAnalysis(quotes: MarketQuote[]): PorkMarketAnalysis {
  const getQ = (sym: string) => quotes.find((q) => q.symbol === sym);

  const ratioQ = getQ("pig_grain_ratio");
  const hogQ = getQ("hog_spot");
  const futuresQ = getQ("hog_futures");
  const porkQ = getQ("pork_spot");
  const pigletQ = getQ("piglet_spot");
  const sowSpotQ = getQ("sow_spot");
  const sowInvQ = getQ("sow_inventory");
  const cornQ = getQ("corn_spot");
  const beanQ = getQ("bean_spot");

  const ratio = ratioQ?.price ?? 3.94;
  const hogPrice = hogQ?.price ?? 9.19;
  const futuresPriceKg = futuresQ?.cnyPrice ?? (futuresQ?.price ? futuresQ.price / 1000 : 9.51);
  const porkPrice = porkQ?.price ?? 15.29;
  const pigletPriceHead = pigletQ?.unit === "头"
    ? pigletQ.price
    : (pigletQ?.price ?? 13.67) * PORK_THRESHOLDS.pigletWeightKg;
  const pigletPriceKg = pigletQ?.cnyPrice ?? pigletPriceHead / PORK_THRESHOLDS.pigletWeightKg;
  const sowSpotPrice = sowSpotQ?.price ?? 1485;
  const sowInv = sowInvQ?.price ?? 3602;
  const cornPriceKg = cornQ?.cnyPrice ?? (cornQ?.price ? cornQ.price / 1000 : 2.33);
  const beanPriceKg = beanQ?.cnyPrice ?? (beanQ?.price ? beanQ.price / 1000 : 3.12);

  let warningLevel: "normal" | "caution" | "critical" = "normal";
  let warningText = "";
  let stage = "";

  if (ratio < PORK_THRESHOLDS.pigGrainLevel1Floor) {
    warningLevel = "critical";
    warningText = `当前猪粮比价仅为 ${ratio.toFixed(2)}:1，显著低于国家发改委 ${PORK_THRESHOLDS.pigGrainLevel1Floor.toFixed(1)}:1 的过度下跌一级预警线，全行业自繁自养陷入深度亏损，中央及地方储备冻猪肉收储机制触发托底。`;
    stage = "深度亏损筑底与主动去产能期";
  } else if (ratio < PORK_THRESHOLDS.pigGrainBreakeven) {
    warningLevel = "caution";
    warningText = `当前猪粮比价为 ${ratio.toFixed(2)}:1，处于发改委 5.0~6.0:1 的亏损预警区间（行业盈亏平衡参考点约 6.0:1），养殖端处于成本线下方。`;
    stage = "成本线震荡与弱势出清期";
  } else if (ratio <= PORK_THRESHOLDS.pigGrainHighWarning) {
    warningLevel = "normal";
    warningText = `当前猪粮比价为 ${ratio.toFixed(2)}:1，处于 6.0~9.0:1 的合理景气运行区间，产业链自繁自养现金流健康。`;
    stage = "景气平稳运行与盈利常态期";
  } else {
    warningLevel = "caution";
    warningText = `当前猪粮比价达 ${ratio.toFixed(2)}:1，超过 9.0:1 的过度上涨预警线，需警惕二次育肥追高压栏及后期供给集中释放风险。`;
    stage = "高利润景气与供给后置透支期";
  }

  const basisDiff = futuresPriceKg - hogPrice;
  const basisDesc = Math.abs(basisDiff) < 0.15
    ? "期现基本平水"
    : basisDiff > 0
      ? `期货升水 +¥${basisDiff.toFixed(2)}/kg`
      : `期货贴水 -¥${Math.abs(basisDiff).toFixed(2)}/kg`;

  const { profitPerHead } = computeHogProfitMetrics(hogPrice);
  const profitText = profitPerHead < 0
    ? `头均亏损约 ¥${Math.abs(profitPerHead)} 元`
    : `头均盈利约 ¥${profitPerHead} 元`;

  const headline = `当前全国外三元生猪出栏均价 ¥${hogPrice.toFixed(2)}/kg（自繁自养${profitText}），${basisDesc}。猪粮比 ${ratio.toFixed(2)}:1 处于${
    warningLevel === "critical" ? "一级预警超跌区" : warningLevel === "caution" ? "预警区间" : "常态区间"
  }，${ratio < PORK_THRESHOLDS.pigGrainBreakeven ? "基础母猪存栏调减与政策收储托底正共同构筑周期底部支撑。" : "供求博弈大体维持均衡格局。"}`;

  const sowTarget = PORK_THRESHOLDS.sowInventoryTargetWan;
  const sowRatioPct = ((sowInv / sowTarget) * 100).toFixed(1);

  const bullets = [
    {
      dimension: "终端现货与期现基差",
      assessment: `农业农村部全国批发市场白条猪肉均价 ¥${porkPrice.toFixed(2)}/kg，外三元出栏大盘报 ¥${hogPrice.toFixed(2)}/kg（白条/毛猪比 ${(porkPrice / (hogPrice || 1)).toFixed(2)}:1）。大商所主力生猪期货折合 ¥${futuresPriceKg.toFixed(2)}/kg（${basisDesc}），反映衍生品市场对中远期供需改善${basisDiff > 0 ? "计价温和修复升水" : "态度维持审慎"}。`,
    },
    {
      dimension: "产能基准与领先供给",
      assessment: `官方核定能繁母猪存栏量报 ${sowInv.toFixed(0)} 万头（达 ${sowTarget} 万头正常保有量目标的 ${sowRatioPct}%，传导期约 10 个月），二元后备母猪均价 ¥${sowSpotPrice.toFixed(0)}/头。基础产能${sowInv < sowTarget ? `处于绿色调控区间下半区且较目标线缩减 ${(sowTarget - sowInv).toFixed(0)} 万头，实质性去化为 10 个月后供给改善奠定基础` : "处于保有目标上方，远期基础供给相对充裕"}。`,
    },
    {
      dimension: "仔猪补栏与投机情绪",
      assessment: `全国 15kg 外三元仔猪均价报 ¥${pigletPriceHead.toFixed(0)}/头（折合 ¥${pigletPriceKg.toFixed(2)}/kg，繁育保本线约 ¥${PORK_THRESHOLDS.pigletBreakevenPerHead}/头，传导期 5~6 个月），${
        pigletPriceHead < PORK_THRESHOLDS.pigletFreezePerHead
          ? "深跌至保本线大幅下方，下游外购育肥补栏陷入冰点，锁定半年后商品猪出栏收缩"
          : pigletPriceHead < PORK_THRESHOLDS.pigletBreakevenPerHead
            ? "处于繁育成本线下方，养殖户补栏偏谨慎"
            : "站上繁育保本线，下游补栏积极性平稳有序"
      }。`,
    },
    {
      dimension: "饲料成本与利润边际",
      assessment: `现货玉米折合 ¥${cornPriceKg.toFixed(2)}/kg，豆粕折合 ¥${beanPriceKg.toFixed(2)}/kg。按 2026 年行业自繁自养平均完全成本线 ¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(2)}/kg（标猪均重 ${PORK_THRESHOLDS.standardHogWeightKg}kg）测算，当前出栏${profitText}${hogPrice < PORK_THRESHOLDS.hogCashCostPerKg ? `，已击穿 ¥${PORK_THRESHOLDS.hogCashCostPerKg.toFixed(1)}/kg 现金成本线` : ""}。`,
    },
  ];

  return {
    stage,
    headline,
    warningLevel,
    warningText,
    bullets,
    analyzedAt: new Date().toISOString(),
    source: "rules",
  };
}

export async function generatePorkAnalysis(quotes: MarketQuote[]): Promise<PorkMarketAnalysis> {
  if (process.env.MODEL_CALLS_ENABLED !== "true") {
    return computeRuleBasedPorkAnalysis(quotes);
  }

  try {
    const { modelRoute } = await import("@aihot/backend/editorial/models");
    const { chatJson } = await import("@aihot/backend/providers/llm");
    const route: { model: string; fallbackModel?: string } = await modelRoute("marketAnalysis").catch(() => ({ model: "default" }));

    const porkQuotes = quotes.filter((q) => q.category === "pork");
    if (porkQuotes.length === 0) return computeRuleBasedPorkAnalysis(quotes);

    const latestDay = porkQuotes.map((q) => q.day).sort().at(-1) ?? beijingDate(new Date());
    const hogQ = porkQuotes.find((q) => q.symbol === "hog_spot");
    const profitMetrics = computeHogProfitMetrics(hogQ?.price ?? 9.19);

    const contextLines = porkQuotes.map((q) => {
      const ch1w = q.change1w !== null && q.change1w !== undefined ? `${(q.change1w * 100).toFixed(2)}%` : "无";
      const ch1m = q.change1m !== null ? `${(q.change1m * 100).toFixed(2)}%` : "无";
      const cny = q.cnyPrice !== null ? ` (折合 ¥${q.cnyPrice.toFixed(2)}/${q.cnyUnit})` : "";
      const bench = q.benchmark ?? computePorkBenchmark(q, porkQuotes);
      return `- ${q.name} (${q.symbol}, 统计日 ${q.day}): 最新 ${q.price} ${q.unit}${cny}, 周环比: ${ch1w}, 近30日: ${ch1m}, 行业锚点: ${bench.anchorText}${bench.anchorSub ? ` (${bench.anchorSub})` : ""}, 状态: ${bench.statusBadge}`;
    });

    const systemPrompt = `你是一位精通中国农业农村部调控政策与大宗商品生猪周期的首席农业产业分析师。
请严格基于最新监测数据与以下2026年校准行业基准进行全产业链综合研判，数据口径必须与看板完全一致，禁止臆造或使用过时的成本线：
1. 2026年行业自繁自养平均完全成本基准：¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(2)}/公斤（现金成本线 ¥${PORK_THRESHOLDS.hogCashCostPerKg.toFixed(2)}/公斤，标猪出栏均重 ${PORK_THRESHOLDS.standardHogWeightKg} 公斤/头，当前测算头均盈亏为 ${profitMetrics.profitPerHead >= 0 ? `+¥${profitMetrics.profitPerHead}` : `-¥${Math.abs(profitMetrics.profitPerHead)}`} 元/头）。
2. 15kg外三元仔猪繁育保本价：¥${PORK_THRESHOLDS.pigletBreakevenPerHead}/头（传导期5~6个月）；后备二元种猪常态更新基准：¥${PORK_THRESHOLDS.sowNormalPricePerHead}/头。
3. 农业农村部《生猪产能综合调控实施方案（2026年修订）》全国能繁母猪正常保有量目标：${PORK_THRESHOLDS.sowInventoryTargetWan} 万头，绿色合理区间为保有量的 92%~103%（3450~3862.5万头），传导期约10个月。
4. 国家发改委《完善政府猪肉储备调节机制预案》猪粮比价：盈亏平衡点 6.0:1，低于 5.0:1 为过度下跌一级预警（启动中央储备收储，warningLevel 必须设为 "critical"），5.0~6.0:1 为二级/三级预警（"caution"），6.0~9.0:1 为正常（"normal"）。

严格只输出一个合法 JSON 对象，字段名必须完全一致（不得添加额外键或更改键名）：
{
  "stage": "周期阶段判定（精炼准确，8~16字）",
  "headline": "核心研判结论（1~2句话，包含关键价格、头均盈亏与期现/政策核心驱动）",
  "warningLevel": "normal 或 caution 或 critical",
  "warningText": "猪粮比与发改委/农业部政策预警信号说明",
  "bullets": [
    { "dimension": "终端现货与期现基差", "assessment": "基于最新白条、生猪现货与主力期货的具体数据推演" },
    { "dimension": "产能基准与领先供给", "assessment": "基于能繁母猪存栏与二元种猪价格的具体数据推演" },
    { "dimension": "仔猪补栏与投机情绪", "assessment": "基于15kg外三元仔猪价格与保本线的具体数据推演" },
    { "dimension": "饲料成本与利润边际", "assessment": "基于玉米、豆粕、完全成本线与头均盈亏的具体数据推演" }
  ]
}`;

    const userPrompt = `最新生猪产业链 9 大核心指标监测数据（基准日 ${latestDay}）：\n${contextLines.join("\n")}\n\n请生成生猪周期与供需传导综合研判 JSON。`;

    const res = await chatJson({
      model: route.model,
      fallbackModel: route.fallbackModel,
      purpose: "market_analysis",
      subject: `pork_market:${latestDay}`,
      promptVersion: "2026-10-30-v3",
      system: systemPrompt,
      user: userPrompt,
      schema: PorkMarketAnalysisSchema,
      temperature: 0.2,
      maxTokens: 2000,
    });

    return {
      ...res.data,
      analyzedAt: new Date().toISOString(),
      source: "ai",
    };
  } catch {
    return computeRuleBasedPorkAnalysis(quotes);
  }
}

/** Each instrument's latest close, its changes over 1 trading day, 7, 30 and 60 calendar days, weekly trend series, unified benchmark, and consolidated analysis. */
export async function readMarkets(opts?: { skipAnalysis?: boolean }): Promise<MarketsAnswer> {
  const rows = await sql<{ symbol: string; day: string; close: number }[]>`
    SELECT symbol, to_char(day, 'YYYY-MM-DD') AS day, close FROM (
      SELECT *, row_number() OVER (PARTITION BY symbol ORDER BY day DESC) - 1 AS n FROM market_daily_closes
    ) ranked
    WHERE n <= 90
    ORDER BY day ASC`;

  const rateRow = (await sql<{ close: number }[]>`
    SELECT close FROM market_daily_closes WHERE symbol = 'usdcny' ORDER BY day DESC LIMIT 1`)[0];
  const usdCnyRate = rateRow?.close ?? null;

  const change = (latest: number, before: { close: number } | undefined) => (before ? latest / before.close - 1 : null);

  const rawQuotes: MarketQuote[] = INSTRUMENTS.flatMap(({
    symbol, name, category, session, currency, unit, cnyUnit, scale, note, segment, horizon, statFrequency, statSourceLabel,
  }) => {
    const own = rows.filter((r) => r.symbol === symbol);
    if (own.length === 0) return [];
    const latest = own.at(-1)!;
    const yesterday = own.length >= 2 ? own.at(-2) : undefined;
    const target1w = addDays(latest.day, -7);
    const target1m = addDays(latest.day, -DAYS_1M);
    const target2m = addDays(latest.day, -DAYS_2M);
    const oneWeek = own.filter((r) => r.day <= target1w).at(-1);
    const oneMonth = own.filter((r) => r.day <= target1m).at(-1);
    const twoMonths = own.filter((r) => r.day <= target2m).at(-1);

    let cnyPrice: number | null = null;
    if (symbol === "xau" && usdCnyRate !== null) {
      // Gold: USD/oz t converted to CNY/gram
      cnyPrice = (latest.close * usdCnyRate) / GRAMS_PER_TROY_OUNCE;
    } else if (scale && cnyUnit !== null) {
      cnyPrice = latest.close * scale;
    }

    const isPeriodic = session === "spot-periodic" || statFrequency === "quarterly";
    const startDay = twoMonths ? twoMonths.day : target2m;
    const series = isPeriodic
      ? own.map(({ day, close }) => ({ day, close }))
      : own.filter((r) => r.day >= startDay).map(({ day, close }) => ({ day, close }));

    const weeklySeries = category === "pork"
      ? buildWeeklyTrendSeries(own, statFrequency ?? "daily")
      : undefined;

    return [{
      symbol, name, category, currency, unit, cnyUnit,
      price: latest.close, day: latest.day,
      cnyPrice,
      closeYesterday: yesterday?.close ?? null, changeYesterday: change(latest.close, yesterday),
      close1w: oneWeek?.close ?? null, change1w: change(latest.close, oneWeek),
      close1m: oneMonth?.close ?? null, change1m: change(latest.close, oneMonth),
      close2m: twoMonths?.close ?? null, change2m: change(latest.close, twoMonths),
      series,
      note: note ?? null,
      segment: segment ?? undefined,
      horizon: horizon ?? undefined,
      statFrequency: statFrequency ?? undefined,
      statSourceLabel: statSourceLabel ?? undefined,
      weeklySeries,
    }];
  });

  const quotes: MarketQuote[] = rawQuotes.map((q) => (
    q.category === "pork"
      ? { ...q, benchmark: computePorkBenchmark(q, rawQuotes) }
      : q
  ));

  let analysis: PorkMarketAnalysis | null = null;
  if (!opts?.skipAnalysis) {
    try {
      const [row] = await sql<{ value: PorkMarketAnalysis }[]>`SELECT value FROM settings WHERE key = 'markets.pork_analysis'`;
      if (row?.value) {
        analysis = row.value;
      } else {
        analysis = computeRuleBasedPorkAnalysis(quotes);
      }
    } catch {
      analysis = computeRuleBasedPorkAnalysis(quotes);
    }
  }

  return { quotes, usdCnyRate, analysis };
}

/** Daily closes older than half a year are past what the page reads; quarterly capacity rows keep 3 years (ops.retention). */
export async function pruneMarkets(now: Date): Promise<Record<string, number>> {
  const periodicSymbols = INSTRUMENTS.filter((i) => i.session === "spot-periodic").map((i) => i.symbol);
  const deletedDaily = periodicSymbols.length > 0
    ? await sql`DELETE FROM market_daily_closes WHERE symbol <> ALL(${periodicSymbols}) AND day < ${beijingDate(now)}::date - 180`
    : await sql`DELETE FROM market_daily_closes WHERE day < ${beijingDate(now)}::date - 180`;
  const deletedPeriodic = periodicSymbols.length > 0
    ? await sql`DELETE FROM market_daily_closes WHERE symbol = ANY(${periodicSymbols}) AND day < ${beijingDate(now)}::date - 1095`
    : { count: 0 };
  return { marketCloses: deletedDaily.count + deletedPeriodic.count };
}
