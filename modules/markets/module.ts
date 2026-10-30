// The markets module's addresses: its public page at /markets (GET /api/markets is already under /api/).
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "markets",
  pages: [{ path: "markets", file: "web/page.tsx" }],
});
