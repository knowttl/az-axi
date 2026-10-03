import { AxiError } from "axi-sdk-js";
import { AZ_READ_CATALOGUE } from "../lib/azReadCatalogue.js";
import { AZ_HELP } from "../lib/azHelp.js";
import { runAz } from "../lib/auth.js";
import { resolveProfile } from "../lib/config.js";
import { commandMeta } from "../lib/registry.js";

export const meta = commandMeta("az");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function refuse(message: string): never { throw new AxiError(message, "VALIDATION_ERROR", [AZ_HELP]); }

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function run(argv: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  const entry = AZ_READ_CATALOGUE.entries.find((candidate) => argv.slice(0, candidate.command.split(" ").length).join(" ") === candidate.command);
  if (!entry) refuse("unsupported passthrough command; only reviewed noncredential ARM reads can run");
  const flags: Record<string, string> = {};
  for (let index = entry.command.split(" ").length; index < argv.length; index++) {
    const token = argv[index]!;
    const [flag, ...inline] = token.split("=");
    const argument = entry.arguments.find((arg) => (arg.flags as readonly string[]).includes(flag!));
    const wrapper = ["--profile", "--config", "--full", "--fields"].includes(flag!);
    if (!argument && !wrapper) refuse(`unsupported passthrough argument ${flag}`);
    const name = argument ? argument.flags[0].slice(2) : flag!.slice(2);
    if (Object.hasOwn(flags, name)) refuse(`duplicate passthrough argument --${name}`);
    const value = flag === "--full" ? (inline.length ? inline.join("=") : "true") :
      inline.length ? inline.join("=") : argv[++index];
    if (!value || value.startsWith("-")) refuse(`missing value for ${flag}`);
    if (flag === "--full" && !["true", "false"].includes(value)) refuse("--full must be true or false");
    flags[name] = value;
  }
  for (const argument of entry.arguments) {
    const value = flags[argument.flags[0].slice(2)];
    if (!value) refuse(`required passthrough flag ${argument.flags[0]}`);
    if (argument.type === "uuid" ? !UUID.test(value) :
      value.length < argument.minLength || value.length > argument.maxLength || !new RegExp(argument.pattern).test(value)) {
      refuse(`invalid value for ${argument.flags[0]}`);
    }
  }
  const fields = flags.fields?.split(",");
  if (fields?.some((field) => !["id", "name", "location", "state"].includes(field))) refuse("--fields accepts id,name,location,state");
  if (fields && flags.full === "true") refuse("--fields and --full are mutually exclusive");
  if (process.env.AZ_AXI_TENANT || process.env.AZ_AXI_SUBSCRIPTION) refuse("passthrough scope must come from the configured profile, without environment scope overrides");
  const profile = resolveProfile({ profile: flags.profile, config: flags.config });
  if (profile.auth !== "az" || profile.source === "implicit") refuse("passthrough requires a configured az-auth profile; token profiles never use ambient login");
  const subscription = flags.subscription!;
  if (!profile.tenant || !UUID.test(profile.tenant) || profile.managementGroup || profile.subscriptions?.length !== 1 ||
    profile.subscriptions[0]?.toLowerCase() !== subscription.toLowerCase() ||
    profile.writeSubscriptions.length !== 1 || profile.writeSubscriptions[0]?.toLowerCase() !== subscription.toLowerCase()) {
    refuse("passthrough requires an explicit profile tenant and one matching configured subscription; scope overrides cannot widen it");
  }
  const tenant = profile.tenant!;
  const cloudName = entry.runtime["cloud"];
  if (!entry.runtime.platforms.includes(process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform as "linux")) refuse("unsupported passthrough platform");
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("passthrough cancelled"));
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const json = async (args: string[]): Promise<Record<string, unknown>> => {
      requestSignal.throwIfAborted();
      const parsed = objectOf(JSON.parse(await runAz(args, requestSignal, true)));
      if (!parsed) refuse("passthrough returned an invalid JSON object");
      return parsed;
    };
    const version = await json(["version", "--output", "json"]);
    const extensions = objectOf(version.extensions);
    if (version["azure-cli"] !== entry.runtime.version || version["azure-cli-core"] !== entry.runtime.version ||
      !extensions || Object.keys(extensions).length) {
      refuse("unsupported passthrough runtime or extension set");
    }
    const cloud = await json(["cloud", "show", "--output", "json"]);
    if (cloud.name !== cloudName || cloud.profile !== entry.runtime.profile || objectOf(cloud.endpoints)?.resourceManager !== "https://management.azure.com/") {
      refuse("unsupported passthrough cloud or API profile");
    }
    const account = await json(["account", "show", "--output", "json"]);
    const user = objectOf(account.user);
    if (typeof account.tenantId !== "string" || account.tenantId.toLowerCase() !== tenant.toLowerCase() ||
      typeof account.id !== "string" || account.id.toLowerCase() !== subscription.toLowerCase() ||
      account.environmentName !== cloudName || account.state !== "Enabled" ||
      typeof user?.name !== "string" || !user.name || !["user", "servicePrincipal"].includes(String(user.type))) {
      refuse("passthrough account identity, tenant or subscription does not match the profile");
    }
    const result = await json([...entry.command.split(" "), ...entry.arguments.flatMap((arg) => [arg.flags[0], flags[arg.flags[0].slice(2)]!]), "--output", "json"]);
    const expectedId = `/subscriptions/${subscription}/resourceGroups/${flags.name}`;
    if (typeof result.id !== "string" || result.id.toLowerCase() !== expectedId.toLowerCase() || result.name !== flags.name) refuse("passthrough response does not match the requested resource group");
    const state = objectOf(result.properties)?.provisioningState;
    const tags = result.tags === undefined ? {} : objectOf(result.tags);
    if (typeof result.location !== "string" || state !== undefined && typeof state !== "string" ||
      !tags || Object.values(tags).some((value) => typeof value !== "string")) refuse("passthrough returned an invalid resource-group envelope");
    const resourceGroup = { id: result.id, name: result.name, location: result.location, state: state ?? "" };
    return { resourceGroup: flags.full === "true" ? { ...resourceGroup, tags } : Object.fromEntries((fields ?? Object.keys(resourceGroup)).map((field) => [field, resourceGroup[field as keyof typeof resourceGroup]])) };
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw new AxiError(requestSignal.aborted ? "passthrough cancelled" : "passthrough failed or exceeded its time/output bounds", "PASSTHROUGH_FAILED", ["Check the supported local runtime and profile; run `az-axi az --help`"]);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
