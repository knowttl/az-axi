import { commandMeta } from "../lib/registry.js";
import { runVmss as run } from "./compute.js";

export const meta = commandMeta("vmss");
export { run };
