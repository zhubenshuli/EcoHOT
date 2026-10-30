// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import markets from "@aihot/markets/web";

export const WEB_MODULES: readonly WebModule[] = [markets];
