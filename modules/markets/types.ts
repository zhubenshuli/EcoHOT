// What GET /api/markets answers, read by the /markets page (web/page.tsx).

export type MarketCategory = "pork" | "macro" | (string & {});

export type PorkStatusTone = "critical" | "caution" | "positive" | "accent" | "neutral";

export type MarketStatFrequency = "daily" | "weekly" | "quarterly";

export interface PorkQuoteBenchmark {
  /** Primary cost/policy anchor text (e.g. "成本倒挂 -30.4%", "毛白价差 ¥6.10/kg", "破 5.0:1 (一级预警)") */
  anchorText: string;
  /** Secondary anchor detail (e.g. "头均亏损约 ¥481", "白条/毛猪比 1.66:1") */
  anchorSub?: string | null;
  /** Optional reference threshold in the quote's primary unit (e.g. 13.2, 300, 1650, 3750, 6.0) */
  referenceLine?: number | null;
  /** Short cyclical status badge */
  statusBadge: string;
  /** Semantic tone for UI styling */
  statusTone: PorkStatusTone;
  /** Dynamic explanation derived from current price, thresholds, and trend */
  statusDesc: string;
}

export interface MarketTrendPoint {
  /** Period label (e.g. "10-26" week-ending date or "26Q3" quarter) */
  label: string;
  /** Period mean or official close */
  close: number;
}

export interface PorkMarketAnalysis {
  /** 周期阶段判定 (如: "深度亏损筑底与主动去产能期") */
  stage: string;
  /** 综合研判一句话总结 */
  headline: string;
  /** 预警等级 */
  warningLevel: "normal" | "caution" | "critical";
  /** 预警等级说明文本 */
  warningText: string;
  /** 各维度详细研判 */
  bullets: Array<{
    dimension: string;
    assessment: string;
  }>;
  /** 分析生成时间 ISO 字符串 */
  analyzedAt: string;
  /** 分析来源：模型调用 ("ai") 或 规则研判引擎 ("rules") */
  source: "ai" | "rules";
}

export interface MarketQuote {
  symbol: string;
  name: string;
  category: MarketCategory;
  /** Currency of the quote: "USD" for Brent and gold, "CNY" for SSE and domestic quotes, "HKD" for HSTECH. */
  currency: "USD" | "CNY" | "HKD";
  /** Unit of the quote: "桶", "盎司", "点", "公斤", "吨", "万头", ":1". */
  unit: string;
  /** The latest close: today's price while its trading day is open. */
  price: number;
  /** The trading day of `price` (YYYY-MM-DD). */
  day: string;
  /** Equivalent RMB price: for gold, converted to CNY/gram; for futures/bulk, converted to CNY/kg; null for SSE. */
  cnyPrice: number | null;
  /** Unit for the RMB price: "克" for gold, "公斤" for feed/futures, null for SSE. */
  cnyUnit: string | null;
  /** The close 1 trading day before (yesterday), and the change against it as a fraction (0.0123 is +1.23%). */
  closeYesterday: number | null;
  changeYesterday: number | null;
  /** The close 7 calendar days before (or preceding trading close), and the WoW change as a fraction. */
  close1w?: number | null;
  change1w?: number | null;
  /** The close 30 calendar days before (or preceding trading close), and the change against it as a fraction (0.0123 is +1.23%). */
  close1m: number | null;
  change1m: number | null;
  /** The close 60 calendar days before (or preceding trading close), and the change against it. */
  close2m: number | null;
  change2m: number | null;
  /** Recent daily closes up to 60 calendar days back, oldest first. */
  series: Array<{ day: string; close: number }>;
  /** Explanatory note or regulatory hint (e.g. "发改委盈亏警戒线约 6.0:1"). */
  note?: string | null;
  /** Pork industry sub-segment: "spot" | "forward" | "cost" */
  segment?: "spot" | "forward" | "cost";
  /** Forward biological / market horizon (e.g. "即期现货", "影响5~6月后出栏", "影响10个月后产能底盘") */
  horizon?: string;
  /** Update cadence of the underlying data source */
  statFrequency?: MarketStatFrequency;
  /** Concise cadence/source badge shown next to stat date (e.g. "日频均价", "农业部日频", "官方季报") */
  statSourceLabel?: string;
  /** Smoothed medium-term weekly average series (or multi-quarter series for periodic capacity) */
  weeklySeries?: MarketTrendPoint[];
  /** Unified backend-computed industry cost / policy benchmark */
  benchmark?: PorkQuoteBenchmark | null;
}

export interface MarketsAnswer {
  quotes: MarketQuote[];
  /** Latest USD/CNY exchange rate used for conversions. */
  usdCnyRate: number | null;
  /** Consolidated analysis for the pork and hog industry. */
  analysis?: PorkMarketAnalysis | null;
}
