import { commandMeta } from "../lib/registry.js";
import { runVm as run } from "./compute.js";

export const meta = commandMeta("vm");
export { run };
