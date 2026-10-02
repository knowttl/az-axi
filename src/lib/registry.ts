import { AxiError } from "axi-sdk-js";
import { redact } from "./redact.js";
import type { RequestClass } from "./policy.js";

/**
 * What a command may do to Azure (PLAN.md Section 6.13.9). `config init` writes a
 * local file only, which is not an Azure effect, so it is still `read`.
 */
export type Effect = "read" | "write" | "destructive" | "dynamic";

export interface CommandMeta {
  name: string;
  effect: Effect;
}

export interface CommandModule {
  meta: CommandMeta;
  run: (args: string[]) => Promise<Record<string, unknown>>;
}

/** Lazy loaders, one per top-level command. Each module exports `meta` and `run`. */
export const COMMANDS: Record<string, () => Promise<CommandModule>> = Object.assign(Object.create(null), {
  home: () => import("../commands/home.js"),
  doctor: () => import("../commands/doctor.js"),
  config: () => import("../commands/config.js"),
  sub: () => import("../commands/sub.js"),
  rg: () => import("../commands/rg.js"),
  rbac: () => import("../commands/rbac.js"),
  activity: () => import("../commands/activity.js"),
  defender: () => import("../commands/defender.js"),
  exposure: () => import("../commands/exposure.js"),
  api: () => import("../commands/api.js"),
});

let activeEffect: Effect | undefined;

/** Runs a command with its declared effect enforced on every request, and redacts its output. */
export async function runCommand(name: string, args: string[]): Promise<Record<string, unknown>> {
  const load = COMMANDS[name];
  if (!load) throw new AxiError(`unknown command \`${name}\``, "VALIDATION_ERROR", ["Run `az-axi --help` for the full command surface"]);
  const { meta, run } = await load();
  return redact(await runWithEffect(meta.effect, () => run(args)));
}

/** Runs `fn` with `effect` enforced on every request it sends through the client. */
export async function runWithEffect<T>(effect: Effect, fn: () => Promise<T>): Promise<T> {
  activeEffect = effect;
  try {
    return await fn();
  } finally {
    activeEffect = undefined;
  }
}

/** Guards against command bugs: a command declared narrower than its requests is refused. */
export function assertEffectAllows(cls: RequestClass): void {
  if (activeEffect === undefined || activeEffect === "dynamic" || activeEffect === "destructive") return;
  if (cls === "read" || cls === "query") return;
  if (activeEffect === "write" && cls === "write") return;
  throw new AxiError(
    `blocked: a command declared '${activeEffect}' issued a '${cls}' request`,
    "READ_ONLY",
    ["This is an az-axi bug: the command's declared effect does not match what it sent"],
  );
}
