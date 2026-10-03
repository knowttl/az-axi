import { runDiscovery } from "../lib/discovery.js";
import { commandMeta } from "../lib/registry.js";

export const meta = commandMeta("group");
export const run = (argv: string[]) => runDiscovery("group", argv);
