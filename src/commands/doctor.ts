import { AxiError } from "axi-sdk-js";
import { SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagString, parseArgs } from "../lib/args.js";
import { identityOf, resolveCredential, runAz, type Identity } from "../lib/auth.js";
import { requestAll } from "../lib/client.js";
import { loadConfig, resolveProfile, writeStatus, type ResolvedProfile } from "../lib/config.js";
import { collapseHomeDirectory } from "../lib/paths.js";
import type { CommandMeta } from "../lib/registry.js";
import { packageInfo } from "../lib/version.js";

export const meta: CommandMeta = { name: "doctor", effect: "read" };

interface Problem {
  check: string;
  optional: boolean;
  error: AxiError;
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, [], "doctor");
  if (args.positionals.length > 0) {
    throw new AxiError(`unexpected argument \`${args.positionals[0]}\` for \`doctor\``, "VALIDATION_ERROR", [
      "Run `az-axi doctor --help` for usage",
    ]);
  }

  const explicit = flagString(args, "config");
  const { path, config } = loadConfig(explicit);
  const requested = flagString(args, "profile");
  const names = requested ? [requested] : Object.keys(config?.profiles ?? {});

  const rows: Record<string, unknown>[] = [];
  const help: string[] = [];
  for (const name of names.length > 0 ? names : [undefined]) {
    const result = await inspect(name, explicit, args);
    rows.push(result.row);
    help.push(...result.help);
  }

  const pkg = packageInfo();
  return {
    package: `${pkg.name} ${pkg.version}`,
    config: config ? collapseHomeDirectory(path) : `${collapseHomeDirectory(path)} (not found; using the implicit az profile)`,
    profiles: rows,
    help: help.length > 0 ? help : ["Run `az-axi sub list` to see visible subscriptions"],
  };
}

async function inspect(
  name: string | undefined,
  explicit: string | undefined,
  args: ReturnType<typeof parseArgs>,
): Promise<{ row: Record<string, unknown>; help: string[] }> {
  let profile: ResolvedProfile;
  try {
    profile = resolveProfile({
      profile: name,
      tenant: flagString(args, "tenant"),
      subscriptions: flagString(args, "subscription")?.split(",").map((s) => s.trim()).filter(Boolean),
      managementGroup: flagString(args, "management-group"),
      config: explicit,
    });
  } catch (err) {
    const error = err as AxiError;
    return {
      row: {
        name: name ?? "az",
        auth: "-",
        identity: "-",
        type: "-",
        subscriptions: "-",
        writes: "-",
        status: `invalid: ${error.message}`,
      },
      help: (error.suggestions ?? []).map((s) => `[${name ?? "az"}] ${s}`),
    };
  }

  const problems: Problem[] = [];
  const attempt = async <T>(check: string, optional: boolean, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      const error =
        err instanceof AxiError ? err : new AxiError(err instanceof Error ? err.message : String(err), "API_ERROR");
      problems.push({ check, optional, error });
      return undefined;
    }
  };

  let identity: Identity | undefined;
  let azAvailable = true;
  if (profile.auth === "az") {
    azAvailable = (await attempt("az", false, () => runAz(["version", "--output", "json"]))) !== undefined;
    if (azAvailable) identity = await attempt("sign-in", false, () => identityOf(profile));
  }

  let armOk = false;
  if (azAvailable) {
    armOk = (await attempt("arm token", false, () => resolveCredential(profile, "arm"))) !== undefined;
    await attempt("logs token", false, () => resolveCredential(profile, "logs"));
    await attempt("graph token", true, () => resolveCredential(profile, "graph"));
  }

  let subscriptions: string | number = "-";
  if (armOk) {
    const listed = await attempt("arm reachable", false, () =>
      requestAll<unknown>(profile, { path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST }),
    );
    if (listed) subscriptions = listed.nextLink ? `${listed.items.length}+` : listed.items.length;
  }

  const blocking = problems.filter((p) => !p.optional);
  const optional = problems.filter((p) => p.optional);
  const tls = problems.some((p) => p.error.code === "TLS_ERROR");
  const status =
    blocking.length > 0
      ? `failed: ${blocking.map((p) => p.check).join(", ")}${tls ? " (tls)" : ""}`
      : optional.length > 0
        ? `ok (${optional.map((p) => `${p.check} unavailable`).join(", ")})`
        : "ok";

  const seen = new Set<string>();
  const help: string[] = [];
  for (const problem of problems) {
    for (const suggestion of [problem.error.message, ...problem.error.suggestions]) {
      const line = `[${profile.name}] ${suggestion}`;
      if (!seen.has(line)) {
        seen.add(line);
        help.push(line);
      }
    }
  }

  return {
    row: {
      name: profile.name,
      auth: profile.auth,
      identity: identity?.name || (profile.auth === "token" ? "(token)" : "-"),
      type: identity?.type ?? (profile.auth === "token" ? "token" : "-"),
      subscriptions,
      writes: writeStatus(profile.allowWrites, profile.writeSubscriptions).label,
      status,
    },
    help,
  };
}
