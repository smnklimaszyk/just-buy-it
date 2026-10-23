// Usage: pnpm --filter @ebay-sniper/sync-design-system sync [design-system folder]
// The folder defaults to ~/intra-ai/design-system, the local copy of the published system.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_NAMES } from "../../../apps/web/src/ui/icon-names.ts";
import { syncDesignSystem } from "./sync.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const source = process.argv[2] ?? join(homedir(), "intra-ai", "design-system");
const target = join(repo, "apps", "web", "design-system");

syncDesignSystem({ source, target, notices: join(repo, "tools", "sync-design-system", "notices"), icons: ICON_NAMES });
process.stdout.write(`Synced ${source} into ${target}\n`);
