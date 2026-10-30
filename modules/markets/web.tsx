// The markets entry in the navigation: under 内容 in the desktop sidebar (after 收藏), and in 工具与入口 on the 我的 page.
import { defineWebModule } from "@aihot/web/modules";
import { IconChart } from "@aihot/web/components/icons";

export default defineWebModule({
  name: "markets",
  sidebar: {
    section: "内容",
    items: [{ to: "/markets", label: "行情", icon: IconChart }],
  },
  tools: [{ to: "/markets", label: "行情", icon: <IconChart size={20} /> }],
});
