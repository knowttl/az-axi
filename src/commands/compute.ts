import { AxiError } from "axi-sdk-js";
import { COMPUTE, COMPUTE_DISKS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagText, parseArgs, type ParsedArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { computeLeafHelp } from "../lib/computeHelp.js";
import { profileFromArgs } from "../lib/context.js";
import { subscriptions } from "../lib/discovery.js";
import { pickFields, truncate } from "../lib/format.js";
import {
  arrOf,
  governanceLimit,
  objOf,
  runGovernanceList,
  runGovernanceShow,
  selectorSuffix,
  str,
  strArr,
  tailName,
  type AnyObj,
  type GovernanceCollection,
  type GovernanceItem,
} from "../lib/governance.js";
import { redact } from "../lib/redact.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { parseSubscriptionId } from "../lib/scope.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("vm");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CELL_TRUNCATE = 200;

function invalid(message: string, path: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [computeLeafHelp(path)]);
}

function segment(value: string, flag: string, path: string): string {
  if (/[/%?#\\]/.test(value) || value === "." || value === ".." || !value.trim()) {
    invalid(`--${flag} must name one resource path segment`, path);
  }
  return encodeURIComponent(value.trim());
}

function basePath(subscription: string, group: string | undefined, arm: string): string {
  return `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Compute/${arm}`;
}

function joined(values: Array<string | number>, full: boolean): string {
  const text = values.map(String).filter(Boolean).join(", ");
  return full ? text : truncate(text, CELL_TRUNCATE).text;
}

function imageSummary(image: AnyObj, full: boolean): string {
  const parts = [str(image.publisher), str(image.offer), str(image.sku), str(image.version)].filter(Boolean);
  if (parts.length) return joined([parts.join(" ")], full);
  const id = str(image.id);
  return id ? tailName(id) : "";
}

function osNameOf(storage: AnyObj): string {
  return str(objOf(storage.osDisk).osType) || str(objOf(storage.imageReference).offer);
}

interface StatusEntry extends AnyObj {
  code?: string;
  displayStatus?: string;
}

/** The display status for the first `prefix/*` code (`PowerState/running` -> `VM running`). */
function statusDisplay(statuses: unknown, prefix: string): string {
  const entries = arrOf(statuses) as StatusEntry[];
  const match = entries.find((entry) => str(entry.code).toLowerCase().startsWith(prefix.toLowerCase()));
  return str(match?.displayStatus) || tailName(str(match?.code));
}

/** One data-disk row: name, LUN and size only, never keys or URIs. */
function dataDiskRow(disk: AnyObj): AnyObj {
  const props = objOf(disk);
  return {
    name: str(disk.name),
    lun: props.lun ?? "",
    sizeGb: props.diskSizeGB ?? "",
  };
}

function vmDetailBody(item: GovernanceItem, full: boolean, limit: number): AnyObj {
  const props = objOf(item.properties);
  const hardware = objOf(props.hardwareProfile);
  const storage = objOf(props.storageProfile);
  const osDisk = objOf(storage.osDisk);
  const dataDisks = arrOf(storage.dataDisks).map(dataDiskRow);
  const shownDisks = full ? dataDisks : dataDisks.slice(0, limit);
  // Present only on the expanded show GET; list rows and plain gets fall back
  // to the model provisioning state below.
  const statuses = arrOf(objOf(props.instanceView).statuses);
  const nics = arrOf(objOf(props.networkProfile).networkInterfaces)
    .map((nic) => tailName(str(nic.id))).filter(Boolean);
  return {
    name: item.name,
    location: full ? str(item.location) : truncate(str(item.location), CELL_TRUNCATE).text,
    size: str(hardware.vmSize),
    os: full ? osNameOf(storage) : truncate(osNameOf(storage), CELL_TRUNCATE).text,
    power: statusDisplay(statuses, "PowerState/"),
    provisioning: statusDisplay(statuses, "ProvisioningState/") || str(props.provisioningState),
    dataDisks: shownDisks,
    totalDataDisks: dataDisks.length,
    ...(full
      ? {
        id: item.id,
        computer: str(objOf(props.osProfile).computerName),
        image: imageSummary(objOf(storage.imageReference), true),
        osDisk: { name: str(osDisk.name), sizeGb: osDisk.diskSizeGB ?? "" },
        nics,
        zone: strArr(item.zones).join(", "),
        availabilitySet: tailName(str(objOf(props.availabilitySet).id)),
        tags: item.tags ?? {},
      }
      : {}),
  };
}

const VM: GovernanceCollection = {
  words: [],
  top: "vm",
  noun: "virtual machines",
  arm: "virtualMachines",
  apiVersion: COMPUTE,
  idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/virtualMachines\/[^/]+$/i,
  listTargets: (subscription, group) => [
    { method: "GET", path: basePath(subscription, group, "virtualMachines"), apiVersion: COMPUTE },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    return {
      name: item.name,
      location: full ? str(item.location) : truncate(str(item.location), CELL_TRUNCATE).text,
      size: str(objOf(props.hardwareProfile).vmSize),
      os: osNameOf(objOf(props.storageProfile)),
      provisioning: str(props.provisioningState),
    };
  },
  fields: ["name", "location", "size", "os", "provisioning"],
  detail: (item, full, limit) => ({ body: vmDetailBody(item, full, limit) }),
  aggregate: (items) => {
    const byLocation: Record<string, number> = {};
    for (const item of items) {
      const location = str(item.location) || "(unknown)";
      byLocation[location] = (byLocation[location] ?? 0) + 1;
    }
    return { byLocation };
  },
};

const VMSS: GovernanceCollection = {
  words: [],
  top: "vmss",
  noun: "virtual machine scale sets",
  arm: "virtualMachineScaleSets",
  apiVersion: COMPUTE,
  idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/virtualMachineScaleSets\/[^/]+$/i,
  listTargets: (subscription, group) => [
    { method: "GET", path: basePath(subscription, group, "virtualMachineScaleSets"), apiVersion: COMPUTE },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    const sku = objOf(item.sku);
    return {
      name: item.name,
      location: full ? str(item.location) : truncate(str(item.location), CELL_TRUNCATE).text,
      sku: str(sku.name),
      capacity: sku.capacity ?? "",
      orchestration: str(props.orchestrationMode),
      provisioning: str(props.provisioningState),
    };
  },
  fields: ["name", "location", "sku", "capacity", "orchestration", "provisioning"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    const sku = objOf(item.sku);
    const profile = objOf(props.virtualMachineProfile);
    const storage = objOf(profile.storageProfile);
    return {
      body: {
        name: item.name,
        location: full ? str(item.location) : truncate(str(item.location), CELL_TRUNCATE).text,
        sku: str(sku.name),
        capacity: sku.capacity ?? "",
        orchestration: str(props.orchestrationMode),
        provisioning: str(props.provisioningState),
        ...(full
          ? {
            id: item.id,
            upgradeMode: str(objOf(props.upgradePolicy).mode),
            computerPrefix: str(objOf(profile.osProfile).computerNamePrefix),
            image: imageSummary(objOf(storage.imageReference), true),
            osType: str(objOf(storage.osDisk).osType),
            zones: strArr(item.zones),
            tags: item.tags ?? {},
          }
          : {}),
      },
    };
  },
  aggregate: (items) => {
    const byLocation: Record<string, number> = {};
    for (const item of items) {
      const location = str(item.location) || "(unknown)";
      byLocation[location] = (byLocation[location] ?? 0) + 1;
    }
    return { byLocation };
  },
};

const DISK: GovernanceCollection = {
  words: [],
  top: "disk",
  noun: "managed disks",
  arm: "disks",
  apiVersion: COMPUTE_DISKS,
  idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/disks\/[^/]+$/i,
  listTargets: (subscription, group) => [
    { method: "GET", path: basePath(subscription, group, "disks"), apiVersion: COMPUTE_DISKS },
  ],
  compact: (item, full) => {
    const props = objOf(item.properties);
    return {
      name: item.name,
      location: full ? str(item.location) : truncate(str(item.location), CELL_TRUNCATE).text,
      sizeGb: props.diskSizeGB ?? "",
      sku: str(objOf(item.sku).name),
      state: str(props.diskState),
      os: str(props.osType),
    };
  },
  fields: ["name", "location", "sizeGb", "sku", "state", "os"],
  detail: (item, full, _limit) => {
    const props = objOf(item.properties);
    return {
      body: {
        name: item.name,
        location: full ? str(item.location) : truncate(str(item.location), CELL_TRUNCATE).text,
        sizeGb: props.diskSizeGB ?? "",
        sku: str(objOf(item.sku).name),
        state: str(props.diskState),
        os: str(props.osType),
        attached: tailName(str(props.managedBy)),
        ...(full
          ? {
            id: item.id,
            timeCreated: str(props.timeCreated),
            encryption: str(objOf(props.encryption).type),
            networkAccess: str(props.networkAccessPolicy),
            zones: strArr(item.zones),
            tags: item.tags ?? {},
            provisioningState: str(props.provisioningState),
          }
          : {}),
      },
    };
  },
  aggregate: (items) => {
    const byLocation: Record<string, number> = {};
    for (const item of items) {
      const location = str(item.location) || "(unknown)";
      byLocation[location] = (byLocation[location] ?? 0) + 1;
    }
    return { byLocation };
  },
};

function showPath(arm: string, subscription: string, group: string | undefined, name: string, path: string): string {
  if (!group) invalid(`${path} by name needs --resource-group`, path);
  return `${basePath(subscription, segment(group, "resource-group", path), arm)}/${segment(name, "name", path)}`;
}

/** One VM selected by name (with resource group, in one subscription) or by ARM ID. */
async function resolveVmTarget(
  profile: ReturnType<typeof profileFromArgs>,
  args: ParsedArgs,
  path: string,
  forInstanceView: boolean,
): Promise<{ getPath: string; subscription: string; vmName: string }> {
  const name = flagText(args, "name");
  const groupFlag = flagText(args, "resource-group");
  const ids = flagText(args, "ids");
  if (name && ids) invalid(`${path} takes --name or --ids, not both`, path);
  if (!name && !ids) invalid(`${path} needs --name with --resource-group, or --ids <vm-ARM-id>`, path);
  if (ids && (groupFlag || name)) {
    invalid("--ids selects the VM itself; name and scope selectors are not accepted with --ids", path);
  }
  if (!ids && !groupFlag) invalid(`${path} by name needs --resource-group`, path);
  if (ids) {
    const id = ids.trim();
    if (/[?#%\\]/.test(id)) invalid("--ids requires an unescaped ARM resource ID without a query or fragment", path);
    if (forInstanceView ? !INSTANCE_VIEW_ID.test(id) : !VM.idTail.test(id)) {
      invalid(forInstanceView
        ? "--ids must be one virtual-machine ARM ID under Microsoft.Compute/virtualMachines, optionally suffixed with /instanceView"
        : "--ids must be one virtual-machine ARM ID under Microsoft.Compute/virtualMachines", path);
    }
    const subMatch = /^\/subscriptions\/([^/]+)\//i.exec(id);
    if (!subMatch || !GUID.test(subMatch[1]!)) invalid("--ids must carry a subscription GUID", path);
    const subscription = subMatch[1]!;
    const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
    if (!selected.some((selectedId) => selectedId.toLowerCase() === subscription.toLowerCase())) {
      invalid("--ids conflicts with selected subscriptions", path);
    }
    const base = id.replace(/\/instanceView$/i, "");
    return {
      getPath: forInstanceView && !/\/instanceView$/i.test(id) ? `${id}/instanceView` : id,
      subscription,
      vmName: tailName(base),
    };
  }
  const selected = await subscriptions(profile);
  if (selected.length !== 1) invalid(`${path} by name needs exactly one subscription; use --subscription <id>`, path);
  const subscription = selected[0]!;
  const base = showPath(VM.arm, subscription, groupFlag, name!, path);
  return { getPath: forInstanceView ? `${base}/instanceView` : base, subscription, vmName: name! };
}

/**
 * `vm show`: one model GET with `$expand=instanceView`, so the live power and
 * provisioning states come from the instance-view statuses in the same call.
 * The expand asks for `instanceView` only, never `userData`.
 */
async function runVmShow(
  profile: ReturnType<typeof profileFromArgs>,
  args: ParsedArgs,
  path: string,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  const limit = governanceLimit(args, path);
  const showFields = Object.keys(vmDetailBody({ id: "", name: "" }, true, limit));
  if (fields?.some((field) => !showFields.includes(field))) {
    invalid(`${path} --fields supports only: ${showFields.join(", ")}`, path);
  }
  const suffix = selectorSuffix(args);
  const { getPath, subscription } = await resolveVmTarget(profile, args, path, false);

  const item = redact(await request<GovernanceItem>(profile,
    { method: "GET", path: getPath, apiVersion: COMPUTE, query: { $expand: "instanceView" } }));
  const body = vmDetailBody(item, full, limit);
  const fullBody = vmDetailBody(item, true, limit);
  const shortened = !full && JSON.stringify(pickFields([body], fields)) !==
    JSON.stringify(pickFields([fullBody], fields));
  const help: string[] = [
    `Run \`az-axi vm get-instance-view ${formatFlagValue("ids", item.id)}${selectorSuffix(args, ["profile", "config", "tenant", "subscription"])}\` for the runtime view`,
  ];
  if (shortened) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` for every nested row`);
  }
  const picked = pickFields([{ ...body, profile: profile.name,
    subscription: parseSubscriptionId(item.id ?? "") ?? subscription }], fields)[0]!;
  return { profile: profile.name, ...picked, help };
}

interface InstanceView extends Record<string, unknown> {
  computerName?: string;
}

/** One disk row: name plus joined status labels, never keys or URIs. */
function instanceDiskRow(disk: AnyObj, full: boolean): AnyObj {
  const statuses = arrOf(disk.statuses).map((entry) => str(entry.displayStatus) || tailName(str(entry.code)));
  return { name: str(disk.name), status: joined(statuses.length ? statuses : [""], full) };
}

/** One extension row: name, type, handler version plus joined status labels. */
function instanceExtensionRow(extension: AnyObj, full: boolean): AnyObj {
  const statuses = arrOf(extension.statuses).map((entry) => str(entry.displayStatus) || tailName(str(entry.code)));
  return {
    name: str(extension.name),
    type: str(extension.type),
    version: str(extension.typeHandlerVersion),
    status: joined(statuses.length ? statuses : [""], full),
  };
}

function instanceViewBody(view: InstanceView, name: string, full: boolean, limit: number): AnyObj {
  const statuses = arrOf(view.statuses);
  const agent = objOf(view.vmAgent);
  const disks = arrOf(view.disks).map((disk) => instanceDiskRow(disk, full));
  const extensions = arrOf(view.extensions).map((extension) => instanceExtensionRow(extension, full));
  return {
    name,
    power: statusDisplay(statuses, "PowerState/"),
    provisioning: statusDisplay(statuses, "ProvisioningState/"),
    os: [str(view.osName), str(view.osVersion)].filter(Boolean).join(" "),
    agent: str(agent.vmAgentVersion) || statusDisplay(agent.statuses, "ProvisioningState/"),
    ...(full
      ? {
        computer: str(view.computerName),
        faultDomain: view.platformFaultDomain ?? "",
        updateDomain: view.platformUpdateDomain ?? "",
        disks: disks.slice(0, limit),
        totalDisks: disks.length,
        extensions: extensions.slice(0, limit),
        totalExtensions: extensions.length,
      }
      : {}),
  };
}

const INSTANCE_VIEW_FIELDS = ["name", "power", "provisioning", "os", "agent",
  "computer", "faultDomain", "updateDomain", "disks", "totalDisks", "extensions", "totalExtensions"];
const INSTANCE_VIEW_ID =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/virtualMachines\/[^/]+(\/instanceView)?$/i;

/**
 * `vm get-instance-view`: one dedicated instanceView GET. Only the runtime
 * view is projected; boot-diagnostic blob URIs, patch details and maintenance
 * status are never printed.
 */
async function runVmInstanceView(
  profile: ReturnType<typeof profileFromArgs>,
  args: ParsedArgs,
  path: string,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !INSTANCE_VIEW_FIELDS.includes(field))) {
    invalid(`${path} --fields supports only: ${INSTANCE_VIEW_FIELDS.join(", ")}`, path);
  }
  const limitValue = governanceLimit(args, path);
  const suffix = selectorSuffix(args);
  const { getPath, subscription, vmName } = await resolveVmTarget(profile, args, path, true);

  const view = redact(await request<InstanceView>(profile,
    { method: "GET", path: getPath, apiVersion: COMPUTE }));
  const body = instanceViewBody(view, vmName, full, limitValue);
  const fullBody = instanceViewBody(view, vmName, true, limitValue);
  for (const field of fields ?? []) {
    if (!(field in body)) body[field] = fullBody[field];
  }
  const shortened = !full && JSON.stringify(pickFields([body], fields)) !==
    JSON.stringify(pickFields([fullBody], fields));
  const help: string[] = [];
  if (shortened) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` for every nested row`);
  }
  const picked = pickFields([{ ...body, profile: profile.name, subscription }], fields)[0]!;
  return { profile: profile.name, ...picked, ...(help.length > 0 ? { help } : {}) };
}

async function runTop(top: string, collection: GovernanceCollection, argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const verb = args.positionals[0];
  const path = `${top} ${verb}`;
  const expected = top === "vm" ? "expected vm list|show|get-instance-view" : `expected ${top} list|show`;
  if (verb !== "list" && verb !== "show" && !(top === "vm" && verb === "get-instance-view")) {
    invalid(expected, path);
  }
  if (args.positionals.length !== 1) {
    invalid(`unexpected argument \`${args.positionals[1]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, computeLeafHelp(path));
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    invalid(`management-group scope is unsupported for ${top} reads; select subscriptions explicitly`, path);
  }
  if (verb === "list") return runGovernanceList(profile, args, collection, path);
  if (top === "vm" && verb === "get-instance-view") return runVmInstanceView(profile, args, path);
  if (top === "vm") return runVmShow(profile, args, path);
  const ids = flagText(args, "ids");
  if (ids) {
    const id = ids.trim();
    if (/[?#%\\]/.test(id)) invalid("--ids requires an unescaped ARM resource ID without a query or fragment", path);
    if (!collection.idTail.test(id)) {
      invalid(`--ids must be one ${collection.noun.slice(0, -1)} ARM ID under Microsoft.Compute/${collection.arm}`, path);
    }
  }
  return runGovernanceShow(profile, args, collection, path, (subscription, group, name) =>
    showPath(collection.arm, subscription, group, name, path));
}

export function runVm(argv: string[]): Promise<Record<string, unknown>> {
  return runTop("vm", VM, argv);
}

export function runVmss(argv: string[]): Promise<Record<string, unknown>> {
  return runTop("vmss", VMSS, argv);
}

export function runDisk(argv: string[]): Promise<Record<string, unknown>> {
  return runTop("disk", DISK, argv);
}
