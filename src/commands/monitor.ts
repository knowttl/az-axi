import { runDiscovery } from "../lib/discovery.js";
import { commandMeta } from "../lib/registry.js";

export const meta = commandMeta("monitor");
export const run = (argv: string[]) => runDiscovery("workspace", argv.slice(2));
