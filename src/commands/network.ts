import { AxiError } from "axi-sdk-js";
import { NETWORK, NETWORK_DNS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs } from "../lib/args.js";
import { request, requestAll } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { subscriptions } from "../lib/discovery.js";
import { countLine, emptyState, pickFields, truncate } from "../lib/format.js";
import { networkLeafHelp } from "../lib/networkHelp.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { parseSubscriptionId } from "../lib/scope.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("network");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const CELL_TRUNCATE = 200;

/** DNS record types with an az `network dns record-set <type>` subgroup. */
const RECORD_TYPES = ["A", "AAAA", "CAA", "CNAME", "MX", "NS", "PTR", "SOA", "SRV", "TXT"] as const;

type AnyObj = Record<string, unknown>;

interface ArmItem extends AnyObj {
  id: string;
  name: string;
  location?: string;
  tags?: unknown;
  properties?: AnyObj;
}

function invalid(message: string, path: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", [networkLeafHelp(path)]);
}

function segment(value: string, flag: string, path: string): string {
  if (/[/%?#\\]/.test(value) || value === "." || value === ".." || !value.trim()) {
    invalid(`--${flag} must name one resource path segment`, path);
  }
  return encodeURIComponent(value.trim());
}

/** Last `depth` resource-name ARM path segments, skipping intermediate
 * collection segments so `.../virtualNetworks/vnet1/subnets/sub1` shortens to
 * `vnet1/sub1` and `.../networkInterfaces/nic1/ipConfigurations/ip1` to
 * `nic1/ip1`. */
function tail(id: string, depth = 1): string {
  const skip = new Set(["subnets", "ipconfigurations"]);
  const parts = id.split("/").filter(Boolean).filter((part) => !skip.has(part.toLowerCase()));
  return parts.slice(-depth).join("/") || id;
}

function propsOf(item: ArmItem): AnyObj {
  const properties = item.properties;
  return properties && typeof properties === "object" ? properties : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): string {
  return typeof value === "number" ? String(value) : "";
}

function arrOf(value: unknown): AnyObj[] {
  return Array.isArray(value) ? value.filter((entry): entry is AnyObj => !!entry && typeof entry === "object") : [];
}

function objOf(value: unknown): AnyObj {
  return value && typeof value === "object" ? (value as AnyObj) : {};
}

function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function joined(values: Array<string | number>, full: boolean): string {
  const text = values.map(String).filter(Boolean).join(", ");
  return full ? text : truncate(text, CELL_TRUNCATE).text;
}

function shortList(values: unknown, full: boolean): string {
  const list = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
  return joined(list, full);
}

interface RuleView {
  name: string;
  priority: string;
  direction: string;
  access: string;
  protocol: string;
  source: string;
  destination: string;
  ports: string;
}

function ruleView(rule: AnyObj, full: boolean): RuleView {
  const properties = objOf(rule.properties);
  const source = [
    ...[str(properties.sourceAddressPrefix)],
    ...strArr(properties.sourceAddressPrefixes),
    ...arrOf(properties.sourceApplicationSecurityGroups).map((group) => tail(str(group.id))),
  ].filter(Boolean).filter((value) => value !== "*");
  const destination = [
    ...[str(properties.destinationAddressPrefix)],
    ...strArr(properties.destinationAddressPrefixes),
    ...arrOf(properties.destinationApplicationSecurityGroups).map((group) => tail(str(group.id))),
  ].filter(Boolean).filter((value) => value !== "*");
  const ports = [
    ...[str(properties.destinationPortRange)],
    ...strArr(properties.destinationPortRanges),
  ].filter(Boolean).filter((value) => value !== "*");
  return {
    name: str(rule.name),
    priority: num(properties.priority) || str(properties.priority),
    direction: str(properties.direction),
    access: str(properties.access),
    protocol: str(properties.protocol),
    source: joined(source.length ? source : ["*"], full),
    destination: joined(destination.length ? destination : ["*"], full),
    ports: joined(ports.length ? ports : ["*"], full),
  };
}

/** Routed values for one DNS record type, in az display order. */
function recordValues(type: string, properties: AnyObj): string[] {
  switch (type) {
    case "A": return arrOf(properties.ARecords).map((record) => str(record.ipv4Address)).filter(Boolean);
    case "AAAA": return arrOf(properties.AAAARecords).map((record) => str(record.ipv6Address)).filter(Boolean);
    case "CAA": return arrOf(properties.CAARecords)
      .map((record) => `${num(record.flags) || str(record.flags)} ${str(record.tag)} "${str(record.value)}"`.trim()).filter((value) => value !== '""');
    case "CNAME": {
      const target = str(objOf(properties.CNAMERecord).cname);
      return target ? [target] : [];
    }
    case "MX": return arrOf(properties.MXRecords)
      .map((record) => `${num(record.preference) || str(record.preference)} ${str(record.exchange)}`.trim()).filter(Boolean);
    case "NS": return arrOf(properties.NSRecords).map((record) => str(record.nsdname)).filter(Boolean);
    case "PTR": return arrOf(properties.PTRRecords).map((record) => str(record.ptrdname)).filter(Boolean);
    case "SOA": {
      const soa = objOf(properties.SOARecord);
      const text = `${str(soa.host)} ${str(soa.email)} ${num(soa.serialNumber) || str(soa.serialNumber)}`.trim();
      return text ? [text] : [];
    }
    case "SRV": return arrOf(properties.SRVRecords)
      .map((record) => `${num(record.priority)} ${num(record.weight)} ${num(record.port)} ${str(record.target)}`.trim()).filter(Boolean);
    case "TXT": return arrOf(properties.TXTRecords).flatMap((record) => strArr(record.value));
    default: return [];
  }
}

/** The record type from a record-set ARM ID (`.../dnszones/{zone}/{TYPE}/{name}`). */
function recordTypeOf(id: string): string {
  const parts = id.split("/").filter(Boolean);
  const zoneIndex = parts.findIndex((part) => part.toLowerCase() === "dnszones");
  return (parts[zoneIndex + 2] ?? "").toUpperCase();
}

interface Collection {
  words: string[];
  noun: string;
  arm: string;
  apiVersion: string;
  /** Validates `--ids` for this collection before any transport. */
  idTail: RegExp;
  listPath(subscription: string, group: string | undefined, zone: string | undefined, recordType: string | undefined, path: string): string;
  compact(item: ArmItem, full: boolean): AnyObj;
  fields: string[];
  detail(item: ArmItem, full: boolean, limit: number): { body: AnyObj; capped: boolean };
}

function basePath(subscription: string, group: string | undefined, arm: string): string {
  return `/subscriptions/${subscription}${group ? `/resourceGroups/${group}` : ""}/providers/Microsoft.Network/${arm}`;
}

const COLLECTIONS: Collection[] = [
  {
    words: ["nsg"], noun: "network security groups", arm: "networkSecurityGroups", apiVersion: NETWORK,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/networkSecurityGroups\/[^/]+$/i,
    listPath: (subscription, group) => basePath(subscription, group, "networkSecurityGroups"),
    compact: (item) => ({
      name: item.name, id: item.id, location: item.location ?? "",
      rules: arrOf(propsOf(item).securityRules).length,
    }),
    fields: ["name", "id", "location", "rules"],
    detail: (item, full, limit) => {
      const properties = propsOf(item);
      const rules = arrOf(properties.securityRules).map((rule) => ruleView(rule, full));
      const shown = full ? rules : rules.slice(0, limit);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          rules: shown, totalRules: rules.length,
          subnets: arrOf(properties.subnets).map((subnet) => tail(str(subnet.id), 2)),
          nics: arrOf(properties.networkInterfaces).map((nic) => tail(str(nic.id))),
          ...(full ? { tags: item.tags ?? {}, provisioningState: str(properties.provisioningState) } : {}),
        },
        capped: shown.length < rules.length,
      };
    },
  },
  {
    words: ["nic"], noun: "network interfaces", arm: "networkInterfaces", apiVersion: NETWORK,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/networkInterfaces\/[^/]+$/i,
    listPath: (subscription, group) => basePath(subscription, group, "networkInterfaces"),
    compact: (item) => {
      const configs = arrOf(propsOf(item).ipConfigurations);
      const first = objOf(configs[0]?.properties);
      return {
        name: item.name, id: item.id, location: item.location ?? "",
        privateIp: str(first.privateIPAddress),
        vm: tail(str(objOf(propsOf(item).virtualMachine).id)),
      };
    },
    fields: ["name", "id", "location", "privateIp", "vm"],
    detail: (item, full, limit) => {
      const properties = propsOf(item);
      const configs = arrOf(properties.ipConfigurations).map((config) => {
        const configProps = objOf(config.properties);
        return {
          name: str(config.name),
          privateIp: str(configProps.privateIPAddress),
          allocation: str(configProps.privateIPAllocationMethod),
          subnet: tail(str(objOf(configProps.subnet).id), 2),
          publicIp: tail(str(objOf(configProps.publicIPAddress).id)),
        };
      });
      const shown = full ? configs : configs.slice(0, limit);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          mac: str(properties.macAddress),
          nsg: tail(str(objOf(properties.networkSecurityGroup).id)),
          vm: tail(str(objOf(properties.virtualMachine).id)),
          ipConfigs: shown, totalIpConfigs: configs.length,
          ...(full ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            enableIPForwarding: properties.enableIPForwarding ?? "",
            dnsLabel: str(objOf(properties.dnsSettings).internalDnsNameLabel),
          } : {}),
        },
        capped: shown.length < configs.length,
      };
    },
  },
  {
    words: ["vnet"], noun: "virtual networks", arm: "virtualNetworks", apiVersion: NETWORK,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+$/i,
    listPath: (subscription, group) => basePath(subscription, group, "virtualNetworks"),
    compact: (item, full) => ({
      name: item.name, id: item.id, location: item.location ?? "",
      prefixes: joined(strArr(objOf(propsOf(item).addressSpace).addressPrefixes), full),
      subnets: arrOf(propsOf(item).subnets).length,
    }),
    fields: ["name", "id", "location", "prefixes", "subnets"],
    detail: (item, full, limit) => {
      const properties = propsOf(item);
      const subnets = arrOf(properties.subnets).map((subnet) => {
        const subnetProps = objOf(subnet.properties);
        const prefix = str(subnetProps.addressPrefix) ||
          shortList(subnetProps.addressPrefixes, full);
        return {
          name: str(subnet.name), prefix,
          nsg: tail(str(objOf(subnetProps.networkSecurityGroup).id)),
          routeTable: tail(str(objOf(subnetProps.routeTable).id)),
        };
      });
      const shownSubnets = full ? subnets : subnets.slice(0, limit);
      const peerings = arrOf(properties.virtualNetworkPeerings).map((peering) => ({
        name: str(peering.name),
        state: str(objOf(peering.properties).peeringState),
        remote: tail(str(objOf(objOf(peering.properties).remoteVirtualNetwork).id)),
      }));
      const shownPeerings = full ? peerings : peerings.slice(0, limit);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          addressSpace: strArr(objOf(properties.addressSpace).addressPrefixes),
          subnets: shownSubnets, totalSubnets: subnets.length,
          peerings: shownPeerings, totalPeerings: peerings.length,
          ...(full ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            dnsServers: strArr(objOf(properties.dhcpOptions).dnsServers),
          } : {}),
        },
        capped: shownSubnets.length < subnets.length || shownPeerings.length < peerings.length,
      };
    },
  },
  {
    words: ["public-ip"], noun: "public IP addresses", arm: "publicIPAddresses", apiVersion: NETWORK,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/publicIPAddresses\/[^/]+$/i,
    listPath: (subscription, group) => basePath(subscription, group, "publicIPAddresses"),
    compact: (item) => ({
      name: item.name, id: item.id, location: item.location ?? "",
      address: str(propsOf(item).ipAddress),
      associated: tail(str(objOf(propsOf(item).ipConfiguration).id), 2),
    }),
    fields: ["name", "id", "location", "address", "associated"],
    detail: (item, full) => {
      const properties = propsOf(item);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          address: str(properties.ipAddress),
          allocation: str(properties.publicIPAllocationMethod),
          version: str(properties.publicIPAddressVersion),
          associated: tail(str(objOf(properties.ipConfiguration).id), 2),
          fqdn: str(objOf(properties.dnsSettings).fqdn),
          sku: str(objOf(item.sku).name),
          zones: Array.isArray(item.zones) ? item.zones.map(String) : [],
          ...(full ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            idleTimeout: num(properties.idleTimeoutInMinutes) || str(properties.idleTimeoutInMinutes),
          } : {}),
        },
        capped: false,
      };
    },
  },
  {
    words: ["private-endpoint"], noun: "private endpoints", arm: "privateEndpoints", apiVersion: NETWORK,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/privateEndpoints\/[^/]+$/i,
    listPath: (subscription, group) => basePath(subscription, group, "privateEndpoints"),
    compact: (item) => {
      const first = objOf(arrOf(propsOf(item).privateLinkServiceConnections)[0]?.properties);
      const state = objOf(first.privateLinkServiceConnectionState);
      return {
        name: item.name, id: item.id, location: item.location ?? "",
        service: tail(str(first.privateLinkServiceId)),
        status: str(state.status),
      };
    },
    fields: ["name", "id", "location", "service", "status"],
    detail: (item, full) => {
      const properties = propsOf(item);
      const connections = arrOf(properties.privateLinkServiceConnections);
      const first = objOf(connections[0]?.properties);
      const state = objOf(first.privateLinkServiceConnectionState);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          service: tail(str(first.privateLinkServiceId)),
          status: str(state.status),
          statusDescription: str(state.description),
          subnet: tail(str(objOf(properties.subnet).id), 2),
          nics: arrOf(properties.networkInterfaces).map((nic) => tail(str(nic.id))),
          dns: arrOf(properties.customDnsConfigs).map((config) => ({
            fqdn: str(config.fqdn),
            ips: strArr(config.ipAddresses).join(", "),
          })),
          ...(full ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            groupIds: strArr(first.groupIds).join(", "),
          } : {}),
        },
        capped: false,
      };
    },
  },
  {
    words: ["dns", "zone"], noun: "DNS zones", arm: "dnszones", apiVersion: NETWORK_DNS,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/dnszones\/[^/]+$/i,
    listPath: (subscription, group) => basePath(subscription, group, "dnszones"),
    compact: (item) => ({
      name: item.name, id: item.id,
      records: num(propsOf(item).numberOfRecordSets) || str(propsOf(item).numberOfRecordSets),
      nameServers: strArr(propsOf(item).nameServers).length,
    }),
    fields: ["name", "id", "records", "nameServers"],
    detail: (item, full) => {
      const properties = propsOf(item);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          records: num(properties.numberOfRecordSets) || str(properties.numberOfRecordSets),
          maxRecords: num(properties.maxNumberOfRecordSets) || str(properties.maxNumberOfRecordSets),
          nameServers: strArr(properties.nameServers),
          ...(full ? { tags: item.tags ?? {} } : {}),
        },
        capped: false,
      };
    },
  },
  {
    words: ["dns", "record-set"], noun: "DNS record sets", arm: "dnszones", apiVersion: NETWORK_DNS,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/dnszones\/[^/]+\/[^/]+\/[^/]+$/i,
    listPath: (subscription, group, zone, recordType, path) =>
      `${basePath(subscription, group, "dnszones")}/${zone!}/${recordType ?? "recordsets"}`,
    compact: (item, full) => {
      const properties = propsOf(item);
      const type = recordTypeOf(item.id);
      return {
        name: item.name, type, ttl: num(properties.TTL) || str(properties.TTL),
        target: joined(recordValues(type, properties), full),
      };
    },
    fields: ["name", "type", "ttl", "target"],
    detail: (item, full) => {
      const properties = propsOf(item);
      const type = recordTypeOf(item.id);
      const values = recordValues(type, properties);
      return {
        body: {
          name: item.name, id: item.id, type,
          ttl: num(properties.TTL) || str(properties.TTL),
          fqdn: str(properties.fqdn),
          records: full ? values : values.map((value) => truncate(value, CELL_TRUNCATE).text),
          ...(full ? { metadata: objOf(properties.metadata) } : {}),
        },
        capped: false,
      };
    },
  },
];

function collectionFor(words: string[], path: string): Collection {
  const found = COLLECTIONS.find((collection) =>
    collection.words.length === words.length && collection.words.every((word, index) => words[index] === word));
  if (!found) {
    invalid("expected network nsg|nic|vnet|public-ip|private-endpoint list|show or network dns zone|record-set list|show", path);
  }
  return found;
}

function limitValue(args: ReturnType<typeof parseArgs>, path: string): number {
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    throw new AxiError("flag --limit needs a number", "VALIDATION_ERROR", [networkLeafHelp(path)]);
  }
  const limit = flagNumber(args, "limit") ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) invalid("--limit must be a positive integer", path);
  if (limit > MAX_LIMIT) invalid(`--limit must be at most ${MAX_LIMIT}`, path);
  return limit;
}

function selectorSuffix(args: ReturnType<typeof parseArgs>): string {
  return ["profile", "config", "tenant", "subscription", "resource-group", "zone-name", "record-type", "name"]
    .filter((key) => typeof args.flags[key] === "string")
    .map((key) => ` ${formatFlagValue(key, args.flags[key] as string)}`).join("");
}

function scopeLabel(subscriptions: string[], group: string | undefined): string {
  const scope = subscriptions.length === 1 ? `in subscription ${subscriptions[0]}` : `in ${subscriptions.length} subscriptions`;
  return group ? `${scope} in resource group ${group}` : scope;
}

async function runList(
  profile: ReturnType<typeof profileFromArgs>,
  args: ReturnType<typeof parseArgs>,
  collection: Collection,
  path: string,
  words: string[],
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !collection.fields.includes(field))) {
    invalid(`${path} --fields supports only: ${collection.fields.join(", ")}`, path);
  }
  const limit = limitValue(args, path);
  const groupFlag = flagText(args, "resource-group");
  const group = groupFlag ? segment(groupFlag, "resource-group", path) : undefined;
  const name = flagText(args, "name");
  const zoneFlag = collection.words[0] === "dns" && words[1] === "record-set" ? flagText(args, "zone-name") : undefined;
  const zone = collection.words[0] === "dns" && words[1] === "record-set"
    ? segment(zoneFlag ?? invalid("dns record-set list needs --zone-name with --resource-group", path), "zone-name", path)
    : undefined;
  if (collection.words[0] === "dns" && words[1] === "record-set" && !groupFlag) {
    invalid("dns record-set list needs --zone-name with --resource-group", path);
  }
  const recordTypeFlag = flagText(args, "record-type");
  const recordType = recordTypeFlag
    ? (RECORD_TYPES as readonly string[]).includes(recordTypeFlag.toUpperCase())
      ? recordTypeFlag.toUpperCase()
      : invalid(`--record-type must be ${RECORD_TYPES.join("|")}, got '${recordTypeFlag}'`, path)
    : undefined;
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    invalid("management-group scope is unsupported for network reads; select subscriptions explicitly", path);
  }

  const subs = await subscriptions(profile);
  const suffix = selectorSuffix(args);
  const collected: ArmItem[] = [];
  let incomplete = false;
  for (const sub of subs) {
    const page = await requestAll<ArmItem>(profile,
      { method: "GET", path: collection.listPath(sub, group, zone, recordType, path), apiVersion: collection.apiVersion }, 100);
    collected.push(...page.items.filter((item) =>
      (!name || item.name.toLowerCase() === name.toLowerCase()) &&
      (recordType === undefined || recordTypeOf(item.id) === recordType)));
    incomplete ||= !!page.nextLink;
  }
  if (collection.words.join(" ") === "dns record-set") {
    collected.sort((a, b) => a.name.localeCompare(b.name) || recordTypeOf(a.id).localeCompare(recordTypeOf(b.id)));
  } else {
    collected.sort((a, b) => a.name.localeCompare(b.name));
  }

  const context = scopeLabel(subs, groupFlag ?? undefined);
  if (collected.length === 0) {
    return {
      profile: profile.name,
      total: incomplete ? "0+" : 0,
      count: countLine(0, 0, collection.noun),
      rows: emptyState(collection.noun, incomplete ? `${context} in fetched pages; listing is incomplete` : context),
      help: [
        `Run \`az-axi ${path}${suffix} --full\` to show every fetched row`,
        ...(incomplete ? ["More pages exist; paging stopped at 100 pages per subscription. Counts are lower bounds. Narrow the subscription or resource-group scope."] : []),
      ],
    };
  }

  const byLocation: Record<string, number> = {};
  for (const item of collected) {
    const location = item.location || "(unknown)";
    byLocation[location] = (byLocation[location] ?? 0) + 1;
  }
  const aggregates: Record<string, unknown> = { byLocation };
  if (collection.words.join(" ") === "dns record-set") {
    const byType: Record<string, number> = {};
    for (const item of collected) {
      const type = recordTypeOf(item.id) || "(unknown)";
      byType[type] = (byType[type] ?? 0) + 1;
    }
    aggregates.byType = byType;
  }

  const shown = (full ? collected : collected.slice(0, limit)).map((item) => collection.compact(item, full));
  const picked = pickFields(shown, fields);
  const first = collected[0]!;
  const firstSub = parseSubscriptionId(first.id) ?? subs[0]!;
  const firstGroup = /\/resourceGroups\/([^/]+)/i.exec(first.id)?.[1];
  const firstSelector = collection.words.join(" ") === "dns record-set"
    ? `--zone-name ${zoneFlag} --resource-group ${groupFlag} --name ${first.name} --record-type ${recordTypeOf(first.id)}`
    : `--name ${first.name}${firstGroup ? ` --resource-group ${firstGroup}` : ""}`;
  const help: string[] = [
    `Run \`az-axi network ${collection.words.join(" ")} show ${firstSelector} --subscription ${firstSub}\` for the first row in detail`,
  ];
  if (shown.length < collected.length) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` to show every fetched row`);
  }
  if (incomplete) {
    help.push("More pages exist; paging stopped at 100 pages per subscription. Counts are lower bounds. Narrow the subscription or resource-group scope.");
  }
  return {
    profile: profile.name,
    total: incomplete ? `${collected.length}+` : collected.length,
    count: countLine(shown.length, collected.length, collection.noun),
    ...aggregates,
    rows: picked,
    help,
  };
}

async function runShow(
  profile: ReturnType<typeof profileFromArgs>,
  args: ReturnType<typeof parseArgs>,
  collection: Collection,
  path: string,
  words: string[],
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  const limit = limitValue(args, path);
  const isRecordSet = collection.words.join(" ") === "dns record-set";
  const name = flagText(args, "name");
  const groupFlag = flagText(args, "resource-group");
  const ids = flagText(args, "ids");
  if (name && ids) invalid(`${path} takes --name or --ids, not both`, path);
  if (!name && !ids) {
    invalid(isRecordSet
      ? `${path} needs --zone-name, --resource-group, --name and --record-type, or --ids <record-set-ARM-id>`
      : `${path} needs --name with --resource-group, or --ids <ARM-id>`, path);
  }
  const zoneFlag = isRecordSet ? flagText(args, "zone-name") : undefined;
  const recordTypeFlag = flagText(args, "record-type");
  const recordType = recordTypeFlag
    ? (RECORD_TYPES as readonly string[]).includes(recordTypeFlag.toUpperCase())
      ? recordTypeFlag.toUpperCase()
      : invalid(`--record-type must be ${RECORD_TYPES.join("|")}, got '${recordTypeFlag}'`, path)
    : undefined;
  if (ids && (groupFlag || name || zoneFlag || recordTypeFlag)) {
    invalid("--ids selects the resource itself; name and scope selectors are not accepted with --ids", path);
  }
  if (!ids && !groupFlag) invalid(`${path} by name needs --resource-group`, path);
  if (isRecordSet && !ids && (!zoneFlag || !recordType)) {
    invalid("dns record-set show by name needs --zone-name, --name and --record-type with --resource-group", path);
  }
  const suffix = selectorSuffix(args);

  let getPath: string;
  let subscription: string;
  if (ids) {
    const id = ids.trim();
    if (/[?#%\\]/.test(id)) invalid("--ids requires an unescaped ARM resource ID without a query or fragment", path);
    const subMatch = /^\/subscriptions\/([^/]+)\//i.exec(id);
    if (!subMatch || !GUID.test(subMatch[1]!)) invalid("--ids must carry a subscription GUID", path);
    const idParts = id.split("/").filter(Boolean);
    if (isRecordSet) {
      const zoneIndex = idParts.findIndex((part) => part.toLowerCase() === "dnszones");
      const type = (idParts[zoneIndex + 2] ?? "").toUpperCase();
      if (zoneIndex < 0 || idParts.length !== zoneIndex + 4 ||
          !(RECORD_TYPES as readonly string[]).includes(type)) {
        invalid("--ids must be one record-set ARM ID: .../dnszones/{zone}/{A|AAAA|CAA|CNAME|MX|NS|PTR|SOA|SRV|TXT}/{name}", path);
      }
    } else if (!collection.idTail.test(id)) {
      invalid(`--ids must be one ${collection.noun.slice(0, -1)} ARM ID under Microsoft.Network/${collection.arm}`, path);
    }
    getPath = id;
    subscription = subMatch[1]!;
    const selected = profile.subscriptions?.length ? await subscriptions(profile) : [subscription];
    if (!selected.some((selectedId) => selectedId.toLowerCase() === subscription.toLowerCase())) {
      invalid("--ids conflicts with selected subscriptions", path);
    }
  } else {
    const selected = await subscriptions(profile);
    if (selected.length !== 1) invalid(`${path} by name needs exactly one subscription; use --subscription <id>`, path);
    subscription = selected[0]!;
    const group = segment(groupFlag!, "resource-group", path);
    getPath = isRecordSet
      ? `${basePath(subscription, group, "dnszones")}/${segment(zoneFlag!, "zone-name", path)}/${recordType}/${segment(name!, "name", path)}`
      : `${basePath(subscription, group, collection.arm)}/${segment(name!, "name", path)}`;
  }

  const item = await request<ArmItem>(profile, { method: "GET", path: getPath, apiVersion: collection.apiVersion });
  const { body, capped } = collection.detail(item, full, limit);
  const showFields = [...collection.fields,
    ...Object.keys(body).filter((key) => !collection.fields.includes(key))];
  if (fields?.some((field) => !showFields.includes(field))) {
    invalid(`${path} --fields supports only: ${showFields.join(", ")}`, path);
  }
  const help: string[] = [];
  if (capped) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` for every nested row`);
  }
  const picked = pickFields([{ ...body, profile: profile.name, subscription: parseSubscriptionId(item.id ?? "") ?? subscription }], fields)[0]!;
  return {
    profile: profile.name,
    ...picked,
    ...(help.length > 0 ? { help } : {}),
  };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const positionalWords = args.positionals.slice(0, 3);
  const verb = positionalWords[positionalWords.length - 1];
  const words = positionalWords.slice(0, -1);
  const path = `network ${words.join(" ")} ${verb}`;
  const collection = collectionFor(words, path);
  if (verb !== "list" && verb !== "show") {
    invalid("expected network nsg|nic|vnet|public-ip|private-endpoint list|show or network dns zone|record-set list|show", path);
  }
  if (args.positionals.length !== words.length + 1) {
    invalid(`unexpected argument \`${args.positionals[words.length + 1]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, networkLeafHelp(path));
  const profile = profileFromArgs(args);
  return verb === "list"
    ? runList(profile, args, collection, path, words)
    : runShow(profile, args, collection, path, words);
}
