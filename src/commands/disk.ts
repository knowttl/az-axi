import { commandMeta } from "../lib/registry.js";
import { runDisk as run } from "./compute.js";

export const meta = commandMeta("disk");
export { run };
