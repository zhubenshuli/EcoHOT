// /markets: domestic pork industry parameters (wholesale pork, live hog, hog futures, piglets,
// breeding sows, sow inventory, hog-to-grain ratio, feed costs) consolidated in a single card
// with AI analysis, weekly/quarterly trend curves, and mobile-responsive layout, plus macro benchmarks.
import { Fragment } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { SITE } from "@aihot/site";
import { beijingStamp, monthDay } from "@aihot/contracts/time";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageReuse } from "@aihot/web/lib/page-reuse";
import { breadcrumbLd, pageMeta } from "@aihot/web/lib/seo";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import { PillTabs, type TabItem } from "@aihot/web/components/ui/Tabs";
import type { Screen } from "@aihot/web/components/shell/screens";
import type {
  MarketCategory,
  MarketQuote,
  MarketsAnswer,
  MarketTrendPoint,
  PorkMarketAnalysis,
  PorkQuoteBenchmark,
  PorkStatusTone,
} from "../types.ts";

export const handle: Screen = { home: "me", name: "行情" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  return cachedPage(60, await apiGet<MarketsAnswer>("/api/markets", { signal: request.signal }));
}

export function meta() {
  return pageMeta({
    title: "行情",
    description: "国内生猪与猪肉产业链价格（农业部白条肉批发、生猪现货与期货、15kg仔猪、二元种猪、能繁母猪存栏、猪粮比价与饲料成本）智能研判及全球大宗商品与主要股指监测。",
    path: "/markets",
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "行情", path: "/markets" }]),
  });
}

/** Extensible tab registry: to add more sectors in the future, append entries here. */
export interface MarketTabDef {
  key: string;
  label: string;
  category: MarketCategory;
  description: string;
}

export const MARKET_TABS: readonly MarketTabDef[] = [
  {
    key: "macro",
    label: "全球大宗与股指",
    category: "macro",
    description: "布伦特原油、伦敦现货黄金（折合人民币克价）、上证指数与恒生科技指数监测",
  },
  {
    key: "pork",
    label: "生猪产业链",
    category: "pork",
    description: "涵盖农业部白条肉、生猪大盘、大商所期货连续、能繁母猪、仔猪补栏、猪粮比价与饲料成本等猪周期核心参数及 AI 智能研判",
  },
];

const formatPrice = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`);
const tone = (value: number | null | undefined) => (value === null || value === undefined || value === 0 ? "text-ink-4" : value > 0 ? "text-hot" : "text-ok");
const prefix = (currency: MarketQuote["currency"]) => (currency === "USD" ? "$" : "");

const TONE_BADGE_CLASSES: Record<PorkStatusTone, string> = {
  critical: "text-hot bg-hot-soft border-hot/30",
  caution: "text-amber-ink bg-amber-soft border-amber/30",
  positive: "text-ok-ink bg-ok-soft border-ok/30",
  accent: "text-accent-ink bg-accent-soft border-accent/30",
  neutral: "text-ink-2 bg-bg-sunk border-line",
};

function formatStatDate(q: MarketQuote, referenceYear: string): { label: string; badge: string } {
  const y = q.day.slice(0, 4);
  const m = Number(q.day.slice(5, 7));
  const d = Number(q.day.slice(8, 10));
  const yearPrefix = y !== referenceYear ? `${y}年` : "";

  if (q.statFrequency === "quarterly" || q.symbol === "sow_inventory") {
    const quarter = Math.ceil(m / 3);
    return { label: `${yearPrefix}Q${quarter}末`, badge: q.statSourceLabel ?? "官方季报" };
  }
  return { label: `${yearPrefix}${m}月${d}日`, badge: q.statSourceLabel ?? "日频均价" };
}

function fallbackBenchmark(q: MarketQuote): PorkQuoteBenchmark {
  return q.benchmark ?? {
    anchorText: "行业参考指标",
    statusBadge: "常态监测",
    statusTone: "neutral",
    statusDesc: q.note ?? "",
  };
}

/**
 * Medium-term cycle sparkline built on weekly averages (8~12 weeks) or official quarterly points,
 * filtering out intraday/weekend noise so cyclical direction and inflection points stand out clearly.
 */
function CycleTrendSparkline({
  points,
  isQuarterly,
  referenceLine,
}: {
  points: MarketTrendPoint[] | undefined;
  isQuarterly: boolean;
  referenceLine?: number | null;
}) {
  if (!points || points.length < 2) {
    return <span className="text-[11px] text-ink-4">—</span>;
  }
  const values = points.map((p) => p.close);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  // Include reference line in scale only when reasonably close (within ±18% of data range) so it doesn't flatten the curve
  const showRef =
    typeof referenceLine === "number" &&
    Number.isFinite(referenceLine) &&
    referenceLine >= dataMin * 0.82 &&
    referenceLine <= dataMax * 1.18;

  const min = showRef ? Math.min(dataMin, referenceLine!) : dataMin;
  const max = showRef ? Math.max(dataMax, referenceLine!) : dataMax;
  const span = max - min || 1;
  const width = 92;
  const height = 26;
  const pad = 3;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = pad + (1 - (p.close - min) / span) * (height - pad * 2);
    return { x, y };
  });
  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const lastCoord = coords.at(-1)!;
  const firstVal = points[0]!.close;
  const lastVal = points.at(-1)!.close;
  const netDiff = lastVal - firstVal;
  const strokeTone = Math.abs(netDiff) < 1e-6 ? "text-ink-4" : netDiff > 0 ? "text-hot" : "text-ok";
  const refY = showRef ? pad + (1 - (referenceLine! - min) / span) * (height - pad * 2) : null;

  const periodTag = isQuarterly ? `近${points.length}季` : `近${points.length}周均`;
  const tooltip = `${periodTag}: ${points[0]!.label} (${formatPrice(firstVal)}) → ${points.at(-1)!.label} (${formatPrice(lastVal)}) | 区间 ${formatPrice(dataMin)} ~ ${formatPrice(dataMax)}`;

  return (
    <div className="inline-flex flex-col items-end" title={tooltip}>
      <svg viewBox={`0 0 ${width} ${height}`} className={`h-6 w-[92px] overflow-visible ${strokeTone}`} aria-hidden="true">
        {refY !== null && (
          <line
            x1={0}
            y1={refY.toFixed(1)}
            x2={width}
            y2={refY.toFixed(1)}
            stroke="currentColor"
            strokeOpacity="0.28"
            strokeWidth="1"
            strokeDasharray="2.5 2.5"
          />
        )}
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={polyline}
        />
        <circle cx={lastCoord.x.toFixed(1)} cy={lastCoord.y.toFixed(1)} r="2.1" fill="currentColor" />
      </svg>
      <div className="num mt-0.5 text-[10px] text-ink-4 whitespace-nowrap">
        {periodTag} {formatPrice(firstVal)}→{formatPrice(lastVal)}
      </div>
    </div>
  );
}

function SparklineLarge({ series, change, currency }: { series: MarketQuote["series"]; change: number | null; currency: MarketQuote["currency"] }) {
  if (series.length < 2) return null;
  const values = series.map((p) => p.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 240;
  const height = 52;
  const pad = 4;
  const points = series.map((p, i) => {
    const x = (i / (series.length - 1)) * width;
    const y = pad + (1 - (p.close - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = change === null || change === 0 ? "text-ink-4" : change > 0 ? "text-hot" : "text-ok";
  const sym = prefix(currency);
  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${width} ${height}`} className={`h-12 w-full overflow-visible ${color}`} aria-hidden="true">
        <polyline fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" points={points} />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-ink-4">
        <span className="num">{monthDay(series[0]!.day)}</span>
        <span className="num">区间 {sym}{formatPrice(min)} – {sym}{formatPrice(max)}</span>
        <span className="num">{monthDay(series.at(-1)!.day)}</span>
      </div>
    </div>
  );
}

function MacroPanel({ q }: { q: MarketQuote }) {
  const isUsd = q.currency === "USD";
  const unitLabel = q.unit.startsWith(":") ? q.unit : `/ ${q.unit}`;
  return (
    <section aria-label={q.name} className="card flex flex-col justify-between p-4 sm:p-5">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[15px] sm:text-[16px] font-bold text-ink">{q.name}</h3>
          <time dateTime={q.day} className="num text-[11.5px] text-ink-4">{monthDay(q.day)}</time>
        </div>
        <div className="mt-2.5">
          <div className="num flex flex-wrap items-baseline gap-1 text-[24px] sm:text-[26px] font-bold leading-tight tracking-tight text-ink">
            {isUsd && <span className="text-[18px] font-semibold text-ink-3">$</span>}
            <span>{formatPrice(q.price)}</span>
            <span className="text-[12px] font-normal text-ink-4">{unitLabel}</span>
          </div>
          {q.cnyPrice !== null && (
            <div className="mt-1 flex flex-wrap items-baseline gap-1 text-[12px]">
              <span className="text-ink-4">折合人民币</span>
              <span className="num font-bold text-accent">约 ¥{formatPrice(q.cnyPrice)}</span>
              <span className="text-[11px] text-ink-4">/ {q.cnyUnit}</span>
            </div>
          )}
        </div>
        <SparklineLarge series={q.series} change={q.change2m ?? q.change1m} currency={q.currency} />
      </div>
      <div className="mt-3.5 grid grid-cols-3 gap-1.5 sm:gap-2">
        <div className="rounded-control bg-bg-sunk px-2 py-1.5 text-center">
          <div className="text-[11px] text-ink-4">较昨日</div>
          <div className={`num mt-0.5 text-[14px] font-bold ${tone(q.changeYesterday)}`}>{formatPct(q.changeYesterday)}</div>
        </div>
        <div className="rounded-control bg-bg-sunk px-2 py-1.5 text-center">
          <div className="text-[11px] text-ink-4">近一月</div>
          <div className={`num mt-0.5 text-[14px] font-bold ${tone(q.change1m)}`}>{formatPct(q.change1m)}</div>
        </div>
        <div className="rounded-control bg-bg-sunk px-2 py-1.5 text-center">
          <div className="text-[11px] text-ink-4">近二月</div>
          <div className={`num mt-0.5 text-[14px] font-bold ${tone(q.change2m)}`}>{formatPct(q.change2m)}</div>
        </div>
      </div>
    </section>
  );
}

function WarningBadge({ level }: { level: PorkMarketAnalysis["warningLevel"] }) {
  if (level === "critical") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-hot/30 bg-hot-soft px-2.5 py-0.5 text-[11.5px] font-bold text-hot">
        <span className="h-1.5 w-1.5 rounded-full bg-hot animate-pulse" />
        过度下跌一级预警
      </span>
    );
  }
  if (level === "caution") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber/30 bg-amber-soft px-2.5 py-0.5 text-[11.5px] font-bold text-amber-ink">
        <span className="h-1.5 w-1.5 rounded-full bg-amber" />
        周期调控预警
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-ok/30 bg-ok-soft px-2.5 py-0.5 text-[11.5px] font-bold text-ok-ink">
      <span className="h-1.5 w-1.5 rounded-full bg-ok" />
      景气运行平稳
    </span>
  );
}

interface PorkSegmentGroup {
  key: "spot" | "forward" | "cost";
  title: string;
  tag: string;
  description: string;
  symbols: string[];
}

const PORK_SEGMENTS: readonly PorkSegmentGroup[] = [
  {
    key: "spot",
    title: "即期现货与衍生品",
    tag: "即期博弈与交割预期",
    description: "反映当下农业部批发市场走货、生猪出栏博弈及大商所期货期现升贴水",
    symbols: ["hog_spot", "pork_spot", "hog_futures"],
  },
  {
    key: "forward",
    title: "中远期领先供给",
    tag: "传导半年至一年后",
    description: "由繁育生物周期决定：能繁母猪传导约10个月，15kg仔猪补栏传导约5~6个月",
    symbols: ["piglet_spot", "sow_spot", "sow_inventory"],
  },
  {
    key: "cost",
    title: "成本支撑与监管警戒",
    tag: "养殖盈亏与政策收储",
    description: "玉米豆粕决定配合料成本底线；猪粮比价触发发改委预警与中央储备肉收储",
    symbols: ["pig_grain_ratio", "corn_spot", "bean_spot"],
  },
];

/** Mobile card representation of a single pork industry metric (< md screens, zero horizontal scroll). */
function MobilePorkIndicatorCard({
  q,
  referenceYear,
}: {
  q: MarketQuote;
  referenceYear: string;
}) {
  const unitLabel = q.unit.startsWith(":") ? q.unit : ` / ${q.unit}`;
  const stat = formatStatDate(q, referenceYear);
  const bench = fallbackBenchmark(q);
  const badgeClass = TONE_BADGE_CLASSES[bench.statusTone] ?? TONE_BADGE_CLASSES.neutral;
  const isQuarterly = q.statFrequency === "quarterly" || q.symbol === "sow_inventory";
  const primaryChange = isQuarterly ? q.changeYesterday : (q.change1w ?? q.changeYesterday);
  const secondaryChange = isQuarterly ? null : q.change1m;

  return (
    <div className="rounded-control border border-line bg-surface p-3.5 space-y-2.5">
      {/* Row 1: Name + Stat Date + Status Badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bold text-[14px] text-ink">{q.name}</span>
            <span className="text-[10.5px] text-ink-4 rounded bg-bg-sunk px-1.5 py-0.5 border border-line-soft">
              {stat.label} · {stat.badge}
            </span>
          </div>
          {q.horizon && (
            <div className="mt-1 text-[11px] text-ink-3">
              传导定位：<span className="font-medium text-ink-2">{q.horizon}</span>
            </div>
          )}
        </div>
        <span className={`shrink-0 inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold border ${badgeClass}`}>
          {bench.statusBadge}
        </span>
      </div>

      {/* Row 2: Price on left, Weekly/Quarterly Trend & Change on right */}
      <div className="flex items-end justify-between gap-3 pt-0.5">
        <div>
          <div className="num font-bold text-[18px] leading-tight text-ink">
            {formatPrice(q.price)}
            <span className="text-[11.5px] font-normal text-ink-4 ml-0.5">{unitLabel}</span>
          </div>
          {q.cnyPrice !== null && (
            <div className="num text-[11.5px] text-accent mt-0.5">
              折合 ¥{formatPrice(q.cnyPrice)}/{q.cnyUnit}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <CycleTrendSparkline
            points={q.weeklySeries}
            isQuarterly={isQuarterly}
            referenceLine={bench.referenceLine}
          />
          <div className="text-right flex flex-col items-end gap-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-ink-4">{isQuarterly ? "季环比" : "周环比"}</span>
              <span className={`num font-bold text-[12.5px] ${tone(primaryChange)}`}>
                {formatPct(primaryChange)}
              </span>
            </div>
            {secondaryChange !== null ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-ink-4">近一月</span>
                <span className={`num font-bold text-[12.5px] ${tone(secondaryChange)}`}>
                  {formatPct(secondaryChange)}
                </span>
              </div>
            ) : isQuarterly ? (
              <span className="text-[11px] text-ink-4">较上季末</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Row 3: Benchmark Anchor & Cyclical Interpretation */}
      <div className="rounded bg-bg-sunk px-2.5 py-2 border border-line-soft text-[11.5px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <span className="font-semibold text-ink">{bench.anchorText}</span>
          {bench.anchorSub && <span className="num text-[11px] text-ink-3">{bench.anchorSub}</span>}
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{bench.statusDesc}</p>
      </div>
    </div>
  );
}

/** The single consolidated summary card combining AI cyclical analysis and all 9 pork indicators. */
function ConsolidatedPorkSummaryCard({
  quotes,
  analysis,
}: {
  quotes: MarketQuote[];
  analysis: PorkMarketAnalysis | null | undefined;
}) {
  const referenceYear = quotes.map((q) => q.day.slice(0, 4)).sort().at(-1) ?? "2026";

  return (
    <section aria-label="生猪与猪肉产业链汇总研判" className="card p-4 sm:p-7 shadow-sm">
      {/* 1. Header: Title, AI Badge, Stage & Regulatory Level */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[18px] sm:text-[20px] font-bold text-ink">
              生猪与猪肉产业链智能研判
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">
              {analysis?.source === "ai" ? "✨ AI 智能研判" : "📊 产业规则引擎"}
            </span>
            {analysis?.warningLevel && <WarningBadge level={analysis.warningLevel} />}
          </div>
          <p className="mt-1 text-[12px] sm:text-[12.5px] text-ink-3">
            统筹监测农业部白条批发、外三元出栏、期货基差、能繁母猪存栏（~10月传导）、15kg仔猪补栏（5~6月传导）、猪粮比价与饲料成本
          </p>
        </div>

        {analysis && (
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto shrink-0">
            <span className="rounded bg-bg-sunk px-2.5 py-1 text-[11.5px] font-medium text-ink-2 border border-line">
              周期阶段：<span className="font-bold text-accent">{analysis.stage}</span>
            </span>
            {analysis.analyzedAt && (
              <time dateTime={analysis.analyzedAt} className="num text-[11px] text-ink-4">
                研判于 {beijingStamp(analysis.analyzedAt)}
              </time>
            )}
          </div>
        )}
      </div>

      {/* 2. AI Headline & Regulatory Alert */}
      {analysis && (
        <div className="mt-5 space-y-3.5">
          <div className="rounded-control bg-well p-4 border border-line">
            <div className="text-[14.5px] sm:text-[15.5px] font-semibold leading-relaxed text-ink">
              {analysis.headline}
            </div>
            {analysis.warningText && (
              <div className="mt-2.5 border-t border-line-soft pt-2 flex items-baseline gap-1.5 text-[12px] sm:text-[12.5px] text-ink-3 leading-relaxed">
                <span className="font-bold text-hot shrink-0">政策预警信号：</span>
                <span>{analysis.warningText}</span>
              </div>
            )}
          </div>

          {/* 4-Dimension Strategic Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {analysis.bullets.map((b) => (
              <div key={b.dimension} className="rounded-control bg-bg-sunk/70 border border-line-soft p-3.5 flex flex-col justify-between">
                <div>
                  <div className="text-[12.5px] font-bold text-ink flex items-center justify-between">
                    <span>{b.dimension}</span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
                    {b.assessment}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Divider */}
      <div className="my-6 border-t border-line" />

      {/* 4. Consolidated Indicators Dashboard (Desktop Table + Mobile Stacked Segment Cards) */}
      <div>
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 mb-3.5">
          <div>
            <h3 className="text-[15px] sm:text-[16px] font-bold text-ink">
              产业链全环节监测看板（9大核心参数）
            </h3>
            <p className="mt-0.5 text-[11.5px] text-ink-3">
              按繁育生物传导周期分层，配套周均/季度去噪趋势曲线与 2026 行业校准成本及部委调控水位
            </p>
          </div>
          <span className="text-[11px] text-ink-4 shrink-0">
            红涨绿跌 · 虚线表示成本或政策平衡基准线
          </span>
        </div>

        {/* 4A. Mobile Stacked Cards (< md) */}
        <div className="space-y-5 md:hidden">
          {PORK_SEGMENTS.map((seg) => {
            const segQuotes = seg.symbols
              .map((sym) => quotes.find((q) => q.symbol === sym))
              .filter((q): q is MarketQuote => q !== undefined);
            if (segQuotes.length === 0) return null;
            return (
              <div key={seg.key} className="space-y-2.5">
                <div className="rounded bg-bg-sunk px-3 py-2 border border-line-soft">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[12.5px] text-ink">{seg.title}</span>
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                      {seg.tag}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-4">{seg.description}</p>
                </div>
                <div className="space-y-2.5">
                  {segQuotes.map((q) => (
                    <MobilePorkIndicatorCard key={q.symbol} q={q} referenceYear={referenceYear} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* 4B. Desktop Structured Table (>= md) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] font-medium text-ink-4">
                <th className="py-2.5 pr-3 font-medium">指标名称与产业链角色</th>
                <th className="py-2.5 px-2.5 font-medium text-right">当前最新值</th>
                <th className="py-2.5 px-2.5 font-medium text-center">前瞻传导周期</th>
                <th className="py-2.5 px-2.5 font-medium text-right">周期趋势(周均/季度)</th>
                <th className="py-2.5 px-2.5 font-medium text-right">环比变化 (周 / 月)</th>
                <th className="py-2.5 px-2.5 font-medium text-left">行业成本 / 政策锚点水位</th>
                <th className="py-2.5 pl-2.5 font-medium text-left">周期所处位置与态势</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {PORK_SEGMENTS.map((seg) => {
                const segQuotes = seg.symbols
                  .map((sym) => quotes.find((q) => q.symbol === sym))
                  .filter((q): q is MarketQuote => q !== undefined);
                if (segQuotes.length === 0) return null;
                return (
                  <Fragment key={seg.key}>
                    <tr className="bg-bg-sunk/70 border-y border-line">
                      <td colSpan={7} className="py-2 px-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-[12.5px] text-ink">{seg.title}</span>
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                            {seg.tag}
                          </span>
                          <span className="text-[11px] text-ink-4">
                            — {seg.description}
                          </span>
                        </div>
                      </td>
                    </tr>
                    {segQuotes.map((q) => {
                      const unitLabel = q.unit.startsWith(":") ? q.unit : ` / ${q.unit}`;
                      const stat = formatStatDate(q, referenceYear);
                      const bench = fallbackBenchmark(q);
                      const badgeClass = TONE_BADGE_CLASSES[bench.statusTone] ?? TONE_BADGE_CLASSES.neutral;
                      const isQuarterly = q.statFrequency === "quarterly" || q.symbol === "sow_inventory";
                      const primaryChange = isQuarterly ? q.changeYesterday : (q.change1w ?? q.changeYesterday);
                      const secondaryChange = isQuarterly ? null : q.change1m;

                      return (
                        <tr key={q.symbol} className="hover:bg-bg-sunk/40 transition-colors">
                          {/* 1. Name & Role */}
                          <td className="py-3 pr-3 max-w-[230px]">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-ink text-[13.5px]">{q.name}</span>
                              <span className="text-[10.5px] text-ink-4 rounded bg-bg-sunk px-1.5 py-0.5 border border-line-soft">
                                {stat.label} · {stat.badge}
                              </span>
                            </div>
                            {q.note && (
                              <div className="text-[11px] text-ink-4 mt-0.5 line-clamp-1" title={q.note}>
                                {q.note}
                              </div>
                            )}
                          </td>

                          {/* 2. Price / Value & Converted unit */}
                          <td className="py-3 px-2.5 text-right">
                            <div className="num font-bold text-[14.5px] text-ink whitespace-nowrap">
                              {formatPrice(q.price)}
                              <span className="text-[11.5px] font-normal text-ink-4 ml-1">{unitLabel}</span>
                            </div>
                            {q.cnyPrice !== null && (
                              <div className="num text-[11px] text-accent mt-0.5 whitespace-nowrap">
                                折合 ¥{formatPrice(q.cnyPrice)}/{q.cnyUnit}
                              </div>
                            )}
                          </td>

                          {/* 3. Horizon */}
                          <td className="py-3 px-2.5 text-center whitespace-nowrap">
                            <span className="inline-block rounded-full bg-well px-2.5 py-1 text-[11px] font-medium text-ink-2 border border-line">
                              {q.horizon ?? "即期"}
                            </span>
                          </td>

                          {/* 4. Smoothed Weekly / Quarterly Trend Sparkline */}
                          <td className="py-3 px-2.5 text-right whitespace-nowrap">
                            <CycleTrendSparkline
                              points={q.weeklySeries}
                              isQuarterly={isQuarterly}
                              referenceLine={bench.referenceLine}
                            />
                          </td>

                          {/* 5. WoW / QoQ + 30d Change */}
                          <td className="py-3 px-2.5 text-right whitespace-nowrap">
                            <div
                              className="inline-flex flex-col items-end gap-1"
                              title={
                                isQuarterly
                                  ? `季环比: ${formatPct(primaryChange)} (较上一季度)`
                                  : `周环比: ${formatPct(primaryChange)} (较7日前)\n近一月: ${formatPct(secondaryChange)} (较30日前)`
                              }
                            >
                              <div className="flex items-center justify-end gap-1.5">
                                <span className="text-[11px] text-ink-4">{isQuarterly ? "季环比" : "周环比"}</span>
                                <span className={`num font-bold text-[12.5px] ${tone(primaryChange)}`}>
                                  {formatPct(primaryChange)}
                                </span>
                              </div>
                              {secondaryChange !== null ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  <span className="text-[11px] text-ink-4">近一月</span>
                                  <span className={`num font-bold text-[12.5px] ${tone(secondaryChange)}`}>
                                    {formatPct(secondaryChange)}
                                  </span>
                                </div>
                              ) : isQuarterly ? (
                                <span className="text-[11px] text-ink-4">较上季末</span>
                              ) : null}
                            </div>
                          </td>

                          {/* 6. Cost / Policy Benchmark */}
                          <td className="py-3 px-2.5">
                            <div className="font-semibold text-[12.5px] text-ink whitespace-nowrap">
                              {bench.anchorText}
                            </div>
                            {bench.anchorSub && (
                              <div className="num text-[11px] text-ink-4 mt-0.5 whitespace-nowrap">
                                {bench.anchorSub}
                              </div>
                            )}
                          </td>

                          {/* 7. Cyclical Position & Tone */}
                          <td className="py-3 pl-2.5 max-w-[230px]">
                            <div className="flex flex-col gap-1 items-start">
                              <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold border ${badgeClass}`}>
                                {bench.statusBadge}
                              </span>
                              <span className="text-[11px] text-ink-3 leading-snug line-clamp-2" title={bench.statusDesc}>
                                {bench.statusDesc}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3 text-[11px] text-ink-4 leading-relaxed">
          <span>
            💡 基准口径说明（2026校准）：自繁自养平均完全成本线参考 ¥13.20/kg（现金成本约 ¥11.50/kg，120kg标猪）；15kg外三元仔猪繁育保本线约 ¥300/头；二元后备种猪常态更新基准约 ¥1650/头；全国能繁母猪正常保有量目标 3750 万头（农业农村部2026修订版，绿色区间 92%~103%）；发改委猪粮比盈亏平衡点 6.0:1，低于 5.0:1 启动一级预警收储。
          </span>
        </div>
      </div>
    </section>
  );
}

export default function MarketsPage() {
  const { quotes, usdCnyRate, analysis } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const currentTab = MARKET_TABS.find((t) => t.key === tabParam) ?? MARKET_TABS[0]!;

  const tabItems: TabItem[] = MARKET_TABS.map((t) => ({
    key: t.key,
    label: t.label,
    to: t.key === MARKET_TABS[0]!.key ? "/markets" : `/markets?tab=${t.key}`,
    replace: true,
    resetScroll: false,
  }));

  const activeQuotes = quotes.filter((q) => q.category === currentTab.category);

  return (
    <div className="pb-10">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="行情" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">行情</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          重点产业链价格监测与智能研判，以及全球大宗商品与主要指数；交易时段与每日零点定时结算更新。
        </p>

        {/* Tab 导航切换器 */}
        <div className="mt-4">
          <PillTabs
            items={tabItems}
            active={currentTab.key}
            layoutId="markets-category-tab"
            label="行情分类"
            size="md"
          />
        </div>
      </header>

      {quotes.length === 0 ? (
        <div className="card mt-5 p-8 text-center text-[13.5px] text-ink-3">暂无行情数据，等待下一次定时更新。</div>
      ) : (
        <div className="mt-4">
          {/* Tab: 生猪产业链 (单卡片汇总 + AI研判 + 9大核心指标看板) */}
          {currentTab.key === "pork" && (
            activeQuotes.length > 0 ? (
              <ConsolidatedPorkSummaryCard quotes={activeQuotes} analysis={analysis} />
            ) : (
              <div className="card p-8 text-center text-[13.5px] text-ink-3">暂无生猪产业链数据。</div>
            )
          )}

          {/* Tab: 全球大宗与股指 (4项基准指标) */}
          {currentTab.key === "macro" && (
            <div>
              <div className="border-b border-line pb-2 mb-4">
                <h2 className="text-[17px] font-bold text-ink">全球大宗商品与主要指数</h2>
                <p className="mt-0.5 text-[12px] text-ink-3">
                  布伦特原油、伦敦现货黄金（1 金衡盎司 ≈ 31.1035 克{usdCnyRate ? `，参考汇率 USD/CNY ${usdCnyRate.toFixed(4)}` : ""}）、上证指数与恒生科技指数
                </p>
              </div>
              {activeQuotes.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
                  {activeQuotes.map((q) => (
                    <MacroPanel key={q.symbol} q={q} />
                  ))}
                </div>
              ) : (
                <div className="card p-8 text-center text-[13.5px] text-ink-3">暂无大宗与指数数据。</div>
              )}
            </div>
          )}

          {/* 默认兜底：未来增加新 Tab（如粮食作物、能源化工等）时的通用自适应渲染 */}
          {currentTab.key !== "pork" && currentTab.key !== "macro" && (
            <div>
              <div className="border-b border-line pb-2 mb-4">
                <h2 className="text-[17px] font-bold text-ink">{currentTab.label}</h2>
                <p className="mt-0.5 text-[12px] text-ink-3">{currentTab.description}</p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {activeQuotes.map((q) => (
                  <MacroPanel key={q.symbol} q={q} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
