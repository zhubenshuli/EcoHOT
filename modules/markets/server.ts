// The markets page's backend: its refresh schedule, its answer and its share of the retention run.
import { defineServerModule } from "@aihot/backend/modules";
import { sendJsonWithEtag } from "@aihot/api/http/respond";
import { pruneMarkets, readMarkets, refreshMacroMarkets, refreshPorkDaily } from "./quotes.ts";
import type { MarketsAnswer } from "./types.ts";

export default defineServerModule({
  name: "markets",
  http(app) {
    app.get("/api/markets", async (req, reply) => {
      const answer: MarketsAnswer = await readMarkets();
      return sendJsonWithEtag(req, reply, answer, { etagPrefix: "markets", cacheControl: "public, max-age=60, s-maxage=60" });
    });
  },
  models: {
    marketAnalysis: {
      label: "生猪与农业产业链智能研判",
      env: "MARKET_ANALYSIS_MODEL",
      purposes: ["market_analysis"],
    },
  },
  schedules: [
    // 1. 生猪产业链 Tab：北京时间每天 0:00 执行，抓取生猪全产业链价格并生成智能研判
    {
      name: "markets.pork.daily",
      cron: "0 0 * * *",
      missed: "once",
      run: () => refreshPorkDaily(),
      when: () => process.env.COLLECT_ENABLED === "true",
    },
    // 2. 全球大宗与股指 Tab：各交易时段内每 10 分钟定时刷新
    {
      name: "markets.macro.refresh",
      cron: "*/10 * * * *",
      run: () => refreshMacroMarkets(),
      when: () => process.env.COLLECT_ENABLED === "true",
    },
  ],
  retention: (now) => pruneMarkets(now),
});
