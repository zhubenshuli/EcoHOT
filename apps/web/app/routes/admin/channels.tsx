import { useEffect, useState } from "react";
import type { Route } from "./+types/channels";
import type { AdminChannelItem, AdminChannelRecentCall, AdminChannels } from "@aihot/contracts/admin";
import { SITE } from "@aihot/site";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Dot, Empty, FilterChips, Stat, Time } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "0";
  return adminGet<AdminChannels>(request, `/api/admin/channels?days=${encodeURIComponent(days)}`);
}

export const meta: Route.MetaFunction = () => [{ title: `模型通道 · ${SITE.name} 后台` }];

const QUOTA_MODE_LABEL: Record<string, string> = {
  nvidia: "NVIDIA 状态码检测 (402/429)",
  apinex: "Apinex 实时接口 (/v1/subscription)",
  tokenharbor: "TokenHarbor 响应头 (x-th-free-used-pct)",
  subscription: "订阅接口查询 (/v1/subscription)",
  "http-status": "HTTP 状态码检测",
};

const PURPOSE_LABEL: Record<string, string> = {
  prefilter_article: "初筛 (prefilter)",
  score_article: "精选打分 (score)",
  understand_article: "内容理解 (understand)",
  summarize_article: "标题摘要写作 (summarize)",
  wording_article: "措辞润色 (wording)",
  structure_article: "结构化抽取 (structure)",
  group_article: "事件归组 (group)",
  group_review: "归组复核 (groupReview)",
  group_story: "故事归组 (groupStory)",
  group_story_review: "故事复核 (groupStoryReview)",
  story_digest: "故事导语 (digest)",
  digest_edition: "早晚报导语 (digest)",
  report_period: "周报月报 (report)",
  translate_article: "翻译 (translate)",
};

const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ChannelsAdmin({ loaderData: d }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [selectedCall, setSelectedCall] = useState<AdminChannelRecentCall | null>(null);
  const [selectedChannelFailures, setSelectedChannelFailures] = useState<AdminChannelItem | null>(null);
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});
  const toggleUsage = (id: string) => setExpandedUsage((prev) => ({ ...prev, [id]: !prev[id] }));

  useEffect(() => {
    if (!selectedCall && !selectedChannelFailures) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedCall(null);
        setSelectedChannelFailures(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCall, selectedChannelFailures]);

  const availableCount = d.channels.filter((c) => c.available).length;
  const activeChannel = d.channels.find((c) => c.id === d.activeChannelId) ?? d.channels[0] ?? null;
  const totalCalls = d.channels.reduce((acc, c) => acc + c.totals.calls, 0);
  const totalOk = d.channels.reduce((acc, c) => acc + c.totals.ok, 0);
  const totalFailed = d.channels.reduce((acc, c) => acc + c.totals.failed, 0);
  const overallRate = totalCalls > 0 ? Math.round((totalOk / totalCalls) * 1000) / 10 : 100;
  const anyAbnormal = d.channels.some((c) => !c.available || c.consecutiveFailures > 0 || c.lastError);
  const periodLabel = d.days <= 0 ? "今日 (UTC 0点起)" : `${d.days} 天`;

  return (
    <AdminPage
      title="模型通道"
      subtitle="多通道按优先级顺位调度：额度耗尽时冻结当前通道并切换至下一通道；单次普通报错仅本次临时借用下一通道，下次请求仍返回原通道；同一通道连续 3 次请求未成功则冷却 1 小时。"
      actions={
        <>
          {anyAbnormal && (
            <Button
              size="sm"
              disabled={pending === "reset-all"}
              onClick={() => run("POST", "/api/admin/channels/all/reset", { reason: "后台手动重置全部通道状态" }, { label: "reset-all", success: "已重置全部通道状态" })}
            >
              重置全部状态
            </Button>
          )}
          <FilterChips
            param="days"
            options={[
              { value: "", label: "今日 (UTC 0点起)" },
              { value: "1", label: "24 小时" },
              { value: "7", label: "7 天" },
              { value: "30", label: "30 天" },
            ]}
          />
        </>
      }
    >
      <div className="mb-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="当前主用通道"
          value={
            activeChannel ? (
              <span className="block truncate" title={activeChannel.host}>
                {activeChannel.host}
              </span>
            ) : (
              "未配置"
            )
          }
          hint={
            activeChannel ? (
              <span className="block truncate" title={activeChannel.model}>
                {activeChannel.model}
              </span>
            ) : (
              "请检查 .env 中的 LLM_BASE_URL"
            )
          }
          tone={activeChannel?.available ? "ok" : "warn"}
        />
        <Stat
          label="可用通道数"
          value={`${availableCount} / ${d.channels.length} 就绪`}
          hint={
            availableCount === d.channels.length
              ? "全部通道在线待命"
              : `${d.channels.filter((c) => c.status === "cooldown").length} 个冷却中 · ${d.channels.filter((c) => c.status === "exhausted").length} 个额度耗尽`
          }
          tone={availableCount === d.channels.length ? "ok" : availableCount > 0 ? "warn" : "bad"}
        />
        <Stat
          label={`${periodLabel}总调用`}
          value={num(totalCalls)}
          hint={`成功 ${num(totalOk)}，失败 ${num(totalFailed)}`}
          tone={overallRate >= 95 ? "ok" : "warn"}
        />
        <Stat
          label="频控与冷却策略"
          value={d.rpm > 0 ? `${d.rpm} RPM` : "不限间隔"}
          hint={`最小间隔 ${(d.intervalMs / 1000).toFixed(0)}s · 连续 3 次报错冷却 1 小时`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5">
        {d.channels.map((ch) => {
          const canReset = !ch.available || ch.consecutiveFailures > 0 || !!ch.lastError;
          return (
            <Card
              key={ch.id}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Badge tone={ch.status === "active" ? "accent" : "muted"}>{`优先级 #${ch.index}`}</Badge>
                  <span className="font-semibold text-ink">{ch.host}</span>
                  <span className="font-mono text-[12px] font-normal text-ink-3 [overflow-wrap:anywhere]">{ch.model}</span>
                  {ch.status === "active" && (
                    <Badge tone="ok">
                      <Dot tone="ok" />
                      正在使用 (当前首选)
                    </Badge>
                  )}
                  {ch.status === "standby" && (
                    <Badge tone="info">
                      <Dot tone="accent" />
                      待命就绪
                    </Badge>
                  )}
                  {ch.status === "cooldown" && (
                    <Badge tone="warn">
                      <Dot tone="warn" />
                      {`冷却中 (至 ${bj(ch.cooldownUntil)})`}
                    </Badge>
                  )}
                  {ch.status === "exhausted" && (
                    <Badge tone="bad">
                      <Dot tone="bad" />
                      {`额度耗尽 (至 ${bj(ch.exhaustedUntil)})`}
                    </Badge>
                  )}
                </span>
              }
              right={
                <div className="flex items-center gap-2">
                  <span className="hidden text-[12px] text-ink-4 sm:inline">{QUOTA_MODE_LABEL[ch.quotaMode] ?? ch.quotaMode}</span>
                  {canReset && (
                    <Button
                      size="sm"
                      disabled={pending === `reset-${ch.id}`}
                      onClick={() =>
                        run("POST", `/api/admin/channels/${ch.id}/reset`, { reason: `手动重置通道 #${ch.index}` }, { label: `reset-${ch.id}`, success: `已重置通道 #${ch.index} 状态` })
                      }
                    >
                      重置状态
                    </Button>
                  )}
                  <Button
                    size="sm"
                    tone="ghost"
                    onClick={() => toggleUsage(ch.id)}
                    className="cursor-pointer"
                  >
                    {expandedUsage[ch.id] ? "收起明细" : "展开明细"}
                  </Button>
                </div>
              }
              pad={false}
            >
              <div className="grid grid-cols-1 gap-3 bg-bg-sunk/40 px-4 py-3 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <div className="text-ink-4">额度与配额状态</div>
                  <div className="mt-0.5 font-medium text-ink">
                    {ch.quotaMode === "apinex" || ch.quotaMode === "subscription" ? (
                      ch.quotaInfo?.remainingTokens != null ? (
                        <span>
                          剩余 <span className="num font-semibold text-ok">{num(ch.quotaInfo.remainingTokens)}</span>
                          {ch.quotaInfo.limitTokens ? ` / ${num(ch.quotaInfo.limitTokens)}` : ""} tokens
                          {ch.quotaInfo.usedPct != null ? ` (已用 ${ch.quotaInfo.usedPct}%)` : ""}
                        </span>
                      ) : (
                        <span>查询 `/v1/subscription` (阈值 {num(d.tokenThreshold)})</span>
                      )
                    ) : ch.quotaMode === "tokenharbor" ? (
                      ch.quotaInfo?.usedPct != null ? (
                        <span>
                          7 天免费额度已用 <span className="num font-semibold">{ch.quotaInfo.usedPct}%</span>
                          {ch.quotaInfo.resetsAt ? ` · 重置 ${bj(ch.quotaInfo.resetsAt)}` : ""}
                        </span>
                      ) : (
                        <span>按响应头 `x-th-free-used-pct` 实时监测</span>
                      )
                    ) : (
                      <span>按状态码 (402 / 429 余额耗尽) 自动监测</span>
                    )}
                  </div>
                </div>

                <div>
                  <div className="text-ink-4">连续失败与冷却计数</div>
                  <div className="mt-0.5 font-medium text-ink">
                    <span className={ch.consecutiveFailures > 0 ? "text-amber font-semibold" : ""}>
                      {`连续失败 ${ch.consecutiveFailures} / ${ch.failureLimit} 次`}
                    </span>
                    {ch.cooldownUntil ? (
                      <span className="ml-1.5 text-amber">· 冷却至 {bj(ch.cooldownUntil)}</span>
                    ) : ch.exhaustedUntil ? (
                      <span className="ml-1.5 text-hot">· 冻结至 {bj(ch.exhaustedUntil)}</span>
                    ) : (
                      <span className="ml-1.5 text-ink-3">· 满 3 次冷却 1h</span>
                    )}
                  </div>
                </div>

                <div>
                  <div className="text-ink-4">{`${periodLabel}累计吞吐`}</div>
                  <div className="mt-0.5 font-medium text-ink">
                    <span className="num">
                      {`成功 ${num(ch.totals.ok)}，`}
                      {ch.totals.failed > 0 ? (
                        <button
                          type="button"
                          onClick={() => setSelectedChannelFailures(ch)}
                          className="cursor-pointer text-hot underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80"
                          title="点击查看最近 3 次失败时间与原因"
                        >
                          {`失败 ${num(ch.totals.failed)}`}
                        </button>
                      ) : (
                        <span>{`失败 ${num(ch.totals.failed)}`}</span>
                      )}
                    </span>
                  </div>
                </div>

                <div>
                  <div className="text-ink-4">最近调用</div>
                  <div className="mt-0.5 font-medium text-ink">
                    <span>最后成功：</span>
                    <Time at={ch.lastSuccessAt} />
                  </div>
                </div>
              </div>

              <div className="border-t border-line bg-bg-sunk/20">
                <button
                  type="button"
                  onClick={() => toggleUsage(ch.id)}
                  className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-[12.5px] transition-colors hover:bg-bg-sunk/50"
                >
                  <span className="inline-flex items-center gap-1.5 font-medium text-ink-2">
                    <svg
                      className={`size-3.5 text-ink-3 transition-transform ${expandedUsage[ch.id] ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    <span>{expandedUsage[ch.id] ? "收起任务用途明细" : "展开任务用途明细"}</span>
                    {ch.usage.length > 0 && <span className="num text-[11px] text-ink-4">({ch.usage.length} 项用途)</span>}
                  </span>
                  <span className="text-[12px] text-ink-4">
                    {ch.usage.length > 0
                      ? `共 ${num(ch.totals.calls)} 次调用 · 成功率 ${Math.round((ch.totals.ok / (ch.totals.calls || 1)) * 1000) / 10}%`
                      : "暂无调用记录"}
                  </span>
                </button>
              </div>

              {expandedUsage[ch.id] && (
                ch.usage.length ? (
                  <DataTable
                    dense
                    rows={ch.usage}
                    rowKey={(u) => u.purpose}
                    columns={[
                      {
                        key: "p",
                        label: "任务用途",
                        render: (u) => (
                          <span className="font-medium text-ink">
                            {PURPOSE_LABEL[u.purpose] ?? u.purpose}
                          </span>
                        ),
                      },
                      { key: "c", label: "调用次数", align: "right", render: (u) => num(u.calls) },
                      {
                        key: "ok",
                        label: "成功率",
                        align: "right",
                        render: (u) => {
                          const rate = u.calls ? u.ok / u.calls : 0;
                          return (
                            <span className={rate < 0.95 ? "text-hot" : "text-ok"} title={`成功 ${u.ok} · 失败 ${u.failed}`}>
                              {`${Math.round(rate * 1000) / 10}%`}
                            </span>
                          );
                        },
                      },
                      { key: "l", label: "耗时 p50 / p95", align: "right", render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span> },
                      { key: "t", label: "输入 / 输出 token", align: "right", render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span> },
                      { key: "at", label: "最近调用", align: "right", render: (u) => <Time at={u.lastAt} /> },
                    ]}
                  />
                ) : (
                  <Empty>{`${periodLabel}内该通道暂无调用记录`}</Empty>
                )
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-6">
        <Card title="最近 30 次通道调用流水" right={<span>展示每次请求最终落地的通道与故障顺延轨迹</span>} pad={false} scrollable>
          <DataTable
            dense
            rows={d.recentCalls}
            rowKey={(r) => r.id}
            empty="暂无调用记录"
            columns={[
              { key: "id", label: "回执 ID", render: (r) => <span className="num font-mono text-[12px] text-ink-3">#{r.id}</span> },
              { key: "at", label: "时间", render: (r) => <span className="num whitespace-nowrap text-[12px]">{bj(r.at, true, true)}</span> },
              {
                key: "ch",
                label: "应答通道",
                render: (r) => {
                  const ch = d.channels.find((c) => c.id === r.channelId);
                  return ch ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge tone={ch.index === 1 ? "accent" : "info"}>{`#${ch.index} ${ch.host}`}</Badge>
                    </span>
                  ) : (
                    <span className="font-mono text-[12px] text-ink-3">{r.channelId ?? "—"}</span>
                  );
                },
              },
              {
                key: "path",
                label: "调度轨迹",
                render: (r) =>
                  r.attemptedChannels.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setSelectedCall(r)}
                      className="group inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pr-1 text-left text-[12px] text-amber transition-opacity hover:opacity-80"
                      title="点击查看顺延具体报错"
                    >
                      <Badge tone="warn">故障顺延</Badge>
                      <span className="font-mono underline decoration-amber/40 underline-offset-2 group-hover:decoration-amber">
                        {r.attemptedChannels.join(" → ")}
                      </span>
                    </button>
                  ) : (
                    <span className="whitespace-nowrap text-[12px] text-ink-4">直连命中</span>
                  ),
              },
              { key: "p", label: "用途", render: (r) => <span className="whitespace-nowrap">{PURPOSE_LABEL[r.purpose] ?? r.purpose}</span> },
              { key: "m", label: "实际模型", render: (r) => <span className="font-mono text-[12px] text-ink-3">{r.model ?? "—"}</span> },
              { key: "l", label: "耗时", align: "right", render: (r) => <span className="num whitespace-nowrap">{secs(r.latencyMs)}</span> },
              { key: "t", label: "输入 / 输出 token", align: "right", render: (r) => <span className="num whitespace-nowrap">{`${num(r.tokensIn)} / ${num(r.tokensOut)}`}</span> },
              {
                key: "s",
                label: "状态",
                align: "right",
                render: (r) =>
                  r.error ? (
                    <button type="button" onClick={() => setSelectedCall(r)} className="cursor-pointer transition-opacity hover:opacity-80" title="点击查看报错详情">
                      <Badge tone={r.status === "completed" || r.status === "received" ? "ok" : r.status === "pending" ? "info" : "bad"}>
                        {r.status}
                      </Badge>
                    </button>
                  ) : (
                    <Badge tone={r.status === "completed" || r.status === "received" ? "ok" : r.status === "pending" ? "info" : "bad"}>
                      {r.status}
                    </Badge>
                  ),
              },
            ]}
          />
        </Card>
      </div>

      {selectedCall && (
        <div className="fixed inset-0 z-[75] flex items-end justify-center p-3 sm:items-center">
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={() => setSelectedCall(null)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-xl rounded-sheet bg-raised p-5 shadow-2xl ring-1 ring-line-strong"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold text-ink">
                  {`回执 #${selectedCall.id} · 顺延报错明细`}
                </h2>
                <div className="mt-1 text-[12.5px] text-ink-3">
                  {`${bj(selectedCall.at, true, true)} · ${PURPOSE_LABEL[selectedCall.purpose] ?? selectedCall.purpose}`}
                  {selectedCall.attemptedChannels.length > 0 && ` · 轨迹 ${selectedCall.attemptedChannels.join(" → ")}`}
                </div>
              </div>
              <Button tone="ghost" size="sm" onClick={() => setSelectedCall(null)}>
                关闭
              </Button>
            </div>

            <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto">
              {selectedCall.failoverErrors.length > 0 ? (
                selectedCall.failoverErrors.map((fe, idx) => {
                  const ch = d.channels.find((c) => c.id === fe.channelId);
                  return (
                    <div key={`${fe.channelId}-${idx}`} className="rounded-control bg-bg-sunk/70 p-3 ring-1 ring-line">
                      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                        <Badge tone="warn">{ch ? `#${ch.index} ${ch.host}` : fe.channelId}</Badge>
                        {ch && <span className="font-mono text-[12px] text-ink-3">{ch.model}</span>}
                      </div>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-hot">
                        {fe.error}
                      </pre>
                    </div>
                  );
                })
              ) : selectedCall.attemptedChannels.length > 1 ? (
                <div className="rounded-control bg-bg-sunk/70 p-3 text-[12.5px] text-ink-3 ring-1 ring-line">
                  <div>
                    切出通道：<span className="font-mono text-ink-2">{selectedCall.attemptedChannels.slice(0, -1).join(", ")}</span>
                  </div>
                  <div className="mt-1 text-ink-4">
                    该条记录产生于此次更新前，未保存单次顺延报错原文；之后新发生的故障顺延会在此完整展示具体报错内容。
                  </div>
                </div>
              ) : null}

              {selectedCall.error && (
                <div className="rounded-control bg-bg-sunk/70 p-3 ring-1 ring-line">
                  <div className="text-[12.5px] font-medium text-hot">最终回执报错</div>
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-hot">
                    {selectedCall.error}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedChannelFailures && (
        <div className="fixed inset-0 z-[75] flex items-end justify-center p-3 sm:items-center">
          <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={() => setSelectedChannelFailures(null)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-xl rounded-sheet bg-raised p-5 shadow-2xl ring-1 ring-line-strong"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold text-ink">
                  {`通道 #${selectedChannelFailures.index} ${selectedChannelFailures.host} · 最近失败记录`}
                </h2>
                <div className="mt-1 text-[12.5px] text-ink-3">
                  <span className="font-mono">{selectedChannelFailures.model}</span>
                  {` · ${periodLabel}累计失败 ${num(selectedChannelFailures.totals.failed)} 次`}
                </div>
              </div>
              <Button tone="ghost" size="sm" onClick={() => setSelectedChannelFailures(null)}>
                关闭
              </Button>
            </div>

            <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto">
              {selectedChannelFailures.recentFailures && selectedChannelFailures.recentFailures.length > 0 ? (
                selectedChannelFailures.recentFailures.slice(0, 3).map((rf, idx) => (
                  <div key={`${rf.at}-${idx}`} className="rounded-control bg-bg-sunk/70 p-3 ring-1 ring-line">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                      <div className="flex items-center gap-2">
                        <Badge tone="bad">失败 #{idx + 1}</Badge>
                        <span className="num font-mono text-[12px] text-ink-2">{bj(rf.at, true, true)}</span>
                        {rf.receiptId && (
                          <span className="font-mono text-[12px] text-ink-3">回执 #{rf.receiptId}</span>
                        )}
                      </div>
                      {rf.purpose && (
                        <span className="text-[12px] text-ink-3">
                          {PURPOSE_LABEL[rf.purpose] ?? rf.purpose}
                        </span>
                      )}
                    </div>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-hot">
                      {rf.error}
                    </pre>
                  </div>
                ))
              ) : selectedChannelFailures.lastError ? (
                <div className="rounded-control bg-bg-sunk/70 p-3 ring-1 ring-line">
                  <div className="flex items-center justify-between gap-2 text-[12.5px]">
                    <Badge tone="bad">最后一次报错</Badge>
                    {selectedChannelFailures.lastErrorAt && (
                      <span className="num font-mono text-[12px] text-ink-2">{bj(selectedChannelFailures.lastErrorAt, true, true)}</span>
                    )}
                  </div>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-hot">
                    {selectedChannelFailures.lastError}
                  </pre>
                </div>
              ) : (
                <div className="rounded-control bg-bg-sunk/70 p-4 text-center text-[13px] text-ink-3 ring-1 ring-line">
                  近期无失败报错记录
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </AdminPage>
  );
}
