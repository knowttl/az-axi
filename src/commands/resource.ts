import { runDiscovery } from "../lib/discovery.js";
import { commandMeta } from "../lib/registry.js";

export const meta = commandMeta("resource");
export const run = (argv: string[]) => runDiscovery("resource", argv);
