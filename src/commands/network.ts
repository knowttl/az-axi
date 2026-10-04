import { AxiError } from "axi-sdk-js";
import { NETWORK, NETWORK_DNS } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, flagText, parseArgs } from "../lib/args.js";
import { buildUrl, request, requestAll, sendRequest } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { diffResource } from "../lib/diff.js";
import { subscriptions } from "../lib/discovery.js";
import { executeWrite } from "../lib/execute.js";
import { countLine, emptyState, pickFields, truncate } from "../lib/format.js";
import { enforceGates } from "../lib/gates.js";
import { parseTimeoutFlag } from "../lib/lro.js";
import { NETWORK_RECORD_TYPES, networkLeafHelp } from "../lib/networkHelp.js";
import { assertReadOnlyBoundary, classifyRequest } from "../lib/policy.js";
import { commandFlags, commandMeta, runWithEffect } from "../lib/registry.js";
import { parseSubscriptionId, shortenResourceId } from "../lib/scope.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("network");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const CELL_TRUNCATE = 200;

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
  const parts = id.split("/").filter(Boolean);
  const names = parts.filter((_, index) => (parts.length - index) % 2 === 1);
  return names.slice(-depth).join("/") || id;
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
  const alias = str(objOf(properties.targetResource).id);
  if (alias && ["A", "AAAA", "CNAME"].includes(type)) return [alias];
  switch (type) {
    case "A": return arrOf(properties.ARecords).map((record) => str(record.ipv4Address)).filter(Boolean);
    case "AAAA": return arrOf(properties.AAAARecords).map((record) => str(record.ipv6Address)).filter(Boolean);
    case "CAA": return arrOf(properties.caaRecords)
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
      const text = [str(soa.host), str(soa.email),
        ...["serialNumber", "refreshTime", "retryTime", "expireTime", "minimumTTL"].map((key) => num(soa[key]) || str(soa[key])),
      ].join(" ").trim();
      return text ? [text] : [];
    }
    case "SRV": return arrOf(properties.SRVRecords)
      .map((record) => `${num(record.priority)} ${num(record.weight)} ${num(record.port)} ${str(record.target)}`.trim()).filter(Boolean);
    case "TXT": return arrOf(properties.TXTRecords).map((record) => strArr(record.value).join(""));
    default: return [];
  }
}

/** The record type from a record-set ARM ID (`.../dnszones/{zone}/{TYPE}/{name}`). */
function recordTypeOf(id: string): string {
  return (/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/dnszones\/[^/]+\/([^/]+)\/[^/]+$/i.exec(id)?.[1] ?? "").toUpperCase();
}

function endpointConnections(properties: AnyObj): AnyObj[] {
  return [...arrOf(properties.privateLinkServiceConnections), ...arrOf(properties.manualPrivateLinkServiceConnections)];
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
  detail(item: ArmItem, full: boolean, limit: number, includeMetadata?: boolean): { body: AnyObj };
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
    detail: (item, full, limit, includeMetadata = full) => {
      const properties = propsOf(item);
      const rules = arrOf(properties.securityRules).map((rule) => ruleView(rule, full));
      const shown = full ? rules : rules.slice(0, limit);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          rules: shown, totalRules: rules.length,
          subnets: arrOf(properties.subnets).map((subnet) => tail(str(subnet.id), 2)),
          nics: arrOf(properties.networkInterfaces).map((nic) => tail(str(nic.id))),
          ...(includeMetadata ? { tags: item.tags ?? {}, provisioningState: str(properties.provisioningState) } : {}),
        },
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
    detail: (item, full, limit, includeMetadata = full) => {
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
          ...(includeMetadata ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            enableIPForwarding: properties.enableIPForwarding ?? "",
            dnsLabel: str(objOf(properties.dnsSettings).internalDnsNameLabel),
          } : {}),
        },
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
    detail: (item, full, limit, includeMetadata = full) => {
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
          ...(includeMetadata ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            dnsServers: strArr(objOf(properties.dhcpOptions).dnsServers),
          } : {}),
        },
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
      associated: tail(str(objOf(propsOf(item).ipConfiguration).id), 2) || tail(str(objOf(propsOf(item).natGateway).id)),
    }),
    fields: ["name", "id", "location", "address", "associated"],
    detail: (item, full, _limit, includeMetadata = full) => {
      const properties = propsOf(item);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          address: str(properties.ipAddress),
          allocation: str(properties.publicIPAllocationMethod),
          version: str(properties.publicIPAddressVersion),
          associated: tail(str(objOf(properties.ipConfiguration).id), 2) || tail(str(objOf(properties.natGateway).id)),
          fqdn: str(objOf(properties.dnsSettings).fqdn),
          sku: str(objOf(item.sku).name),
          zones: Array.isArray(item.zones) ? item.zones.map(String) : [],
          ...(includeMetadata ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            idleTimeout: num(properties.idleTimeoutInMinutes) || str(properties.idleTimeoutInMinutes),
          } : {}),
        },
      };
    },
  },
  {
    words: ["private-endpoint"], noun: "private endpoints", arm: "privateEndpoints", apiVersion: NETWORK,
    idTail: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/privateEndpoints\/[^/]+$/i,
    listPath: (subscription, group) => basePath(subscription, group, "privateEndpoints"),
    compact: (item) => {
      const first = objOf(endpointConnections(propsOf(item))[0]?.properties);
      const state = objOf(first.privateLinkServiceConnectionState);
      return {
        name: item.name, id: item.id, location: item.location ?? "",
        service: tail(str(first.privateLinkServiceId)),
        status: str(state.status),
      };
    },
    fields: ["name", "id", "location", "service", "status"],
    detail: (item, full, _limit, includeMetadata = full) => {
      const properties = propsOf(item);
      const connections = endpointConnections(properties);
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
          ...(includeMetadata ? {
            tags: item.tags ?? {}, provisioningState: str(properties.provisioningState),
            groupIds: strArr(first.groupIds).join(", "),
          } : {}),
        },
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
    detail: (item, full, _limit, includeMetadata = full) => {
      const properties = propsOf(item);
      return {
        body: {
          name: item.name, id: item.id, location: item.location ?? "",
          records: num(properties.numberOfRecordSets) || str(properties.numberOfRecordSets),
          maxRecords: num(properties.maxNumberOfRecordSets) || str(properties.maxNumberOfRecordSets),
          nameServers: strArr(properties.nameServers),
          ...(includeMetadata ? { tags: item.tags ?? {} } : {}),
        },
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
    detail: (item, full, _limit, includeMetadata = full) => {
      const properties = propsOf(item);
      const type = recordTypeOf(item.id);
      const values = recordValues(type, properties);
      return {
        body: {
          name: item.name, id: item.id, type,
          ttl: num(properties.TTL) || str(properties.TTL),
          fqdn: str(properties.fqdn),
          records: full ? values : values.map((value) => truncate(value, CELL_TRUNCATE).text),
          ...(includeMetadata ? { metadata: objOf(properties.metadata) } : {}),
        },
      };
    },
  },
];

function collectionFor(words: string[], path: string): Collection {
  const found = COLLECTIONS.find((collection) =>
    collection.words.length === words.length && collection.words.every((word, index) => words[index] === word));
  if (!found) {
    invalid("expected network nsg|nic|vnet|public-ip|private-endpoint list|show, dns zone list|show, or dns record-set [a|aaaa|caa|cname|mx|ns|ptr|soa|srv|txt] list|show", path);
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

function selectorSuffix(args: ReturnType<typeof parseArgs>, keys = ["profile", "config", "tenant", "subscription", "resource-group", "zone-name", "name", "ids"]): string {
  return keys
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
  recordType: string | undefined,
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
  const isRecordSet = collection.words.join(" ") === "dns record-set";
  const zoneFlag = isRecordSet ? flagText(args, "zone-name") : undefined;
  const zone = isRecordSet
    ? segment(zoneFlag ?? invalid("dns record-set list needs --zone-name with --resource-group", path), "zone-name", path)
    : undefined;
  if (isRecordSet && !groupFlag) {
    invalid("dns record-set list needs --zone-name with --resource-group", path);
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

  const displayed = full ? collected : collected.slice(0, limit);
  const shown = displayed.map((item) => collection.compact(item, full));
  const picked = pickFields(shown, fields);
  const shortened = !full && JSON.stringify(picked) !== JSON.stringify(pickFields(displayed.map((item) => collection.compact(item, true)), fields));
  const first = collected[0]!;
  const firstSub = parseSubscriptionId(first.id) ?? subs[0]!;
  const firstGroup = /\/resourceGroups\/([^/]+)/i.exec(first.id)?.[1];
  const firstSelector = collection.words.join(" ") === "dns record-set"
    ? `${formatFlagValue("zone-name", zoneFlag!)} ${formatFlagValue("resource-group", groupFlag!)} ${formatFlagValue("name", first.name)}`
    : `${formatFlagValue("name", first.name)}${firstGroup ? ` ${formatFlagValue("resource-group", firstGroup)}` : ""}`;
  const help: string[] = [
    `Run \`az-axi network ${collection.words.join(" ")}${isRecordSet ? ` ${recordTypeOf(first.id).toLowerCase()}` : ""} show ${firstSelector} ${formatFlagValue("subscription", firstSub)}${selectorSuffix(args, ["profile", "config", "tenant"])}\` for the first row in detail`,
  ];
  if (shown.length < collected.length || shortened) {
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
  recordType: string | undefined,
): Promise<Record<string, unknown>> {
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  const limit = limitValue(args, path);
  const showFields = Object.keys(collection.detail({ id: "", name: "" }, true, limit).body);
  if (fields?.some((field) => !showFields.includes(field))) {
    invalid(`${path} --fields supports only: ${showFields.join(", ")}`, path);
  }
  const isRecordSet = collection.words.join(" ") === "dns record-set";
  const name = flagText(args, "name");
  const groupFlag = flagText(args, "resource-group");
  const ids = flagText(args, "ids");
  if (name && ids) invalid(`${path} takes --name or --ids, not both`, path);
  if (!name && !ids) {
    invalid(isRecordSet
      ? `${path} needs --zone-name, --resource-group and --name, or --ids <record-set-ARM-id>`
      : `${path} needs --name with --resource-group, or --ids <ARM-id>`, path);
  }
  const zoneFlag = isRecordSet ? flagText(args, "zone-name") : undefined;
  if (ids && (groupFlag || name || zoneFlag)) {
    invalid("--ids selects the resource itself; name and scope selectors are not accepted with --ids", path);
  }
  if (!ids && !groupFlag) invalid(`${path} by name needs --resource-group`, path);
  if (isRecordSet && !ids && !zoneFlag) {
    invalid("dns record-set show by name needs --zone-name and --name with --resource-group", path);
  }
  const suffix = selectorSuffix(args);

  let getPath: string;
  let subscription: string;
  if (ids) {
    const id = ids.trim();
    if (/[?#%\\]/.test(id)) invalid("--ids requires an unescaped ARM resource ID without a query or fragment", path);
    const subMatch = /^\/subscriptions\/([^/]+)\//i.exec(id);
    if (!subMatch || !GUID.test(subMatch[1]!)) invalid("--ids must carry a subscription GUID", path);
    if (isRecordSet) {
      if (recordTypeOf(id) !== recordType) {
        invalid(`--ids must be one ${recordType} record-set ARM ID: .../dnszones/{zone}/${recordType}/{name}`, path);
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
  const { body } = collection.detail(item, full, limit, full || !!fields);
  const shortened = !full && JSON.stringify(pickFields([body], fields)) !==
    JSON.stringify(pickFields([collection.detail(item, true, limit, full || !!fields).body], fields));
  const help: string[] = [];
  if (shortened) {
    help.push(`Run \`az-axi ${path}${suffix} --full\` for every nested row`);
  }
  const picked = pickFields([{ ...body, profile: profile.name, subscription: parseSubscriptionId(item.id ?? "") ?? subscription }], fields)[0]!;
  return {
    profile: profile.name,
    ...picked,
    ...(help.length > 0 ? { help } : {}),
  };
}

/**
 * Slice 10c: one Deny rule on one existing NSG (destructive). Deny rules can
 * cut live traffic, so this is the first native leaf with the destructive
 * effect: typed --confirm on top of every write gate. Existence checks refuse
 * known conflicts, but the child PUT has no documented atomic create-only
 * protection. See README.md#writes for the concurrency limits.
 */
const NSG_ID =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/networkSecurityGroups\/([^/]+)$/i;
const NSG_RULE_DIRECTIONS: Record<string, string> = { inbound: "Inbound", outbound: "Outbound" };
const NSG_RULE_PROTOCOLS: Record<string, string> = {
  "*": "*", tcp: "Tcp", udp: "Udp", icmp: "Icmp", esp: "Esp", ah: "Ah",
};
const NSG_RULE_PROTECTION =
  "Best effort: Azure documents no atomic create-only protection; a concurrent create of the same rule name between preview and execution cannot be ruled out";
const NSG_RULE_ROW_FIELDS = ["name", "priority", "direction", "access"];
const PORT_ENTRY = /^(\*|\d+(-\d+)?)$/;

interface NsgRuleItem {
  name?: string;
  properties?: { priority?: number; direction?: string; access?: string };
}

interface NsgItem {
  id: string;
  name: string;
  etag?: string;
  properties?: { securityRules?: NsgRuleItem[] };
}

/** Exactly one explicit subscription GUID: names and implicit env/profile scope are refused. */
function explicitSubscriptionId(args: ReturnType<typeof parseArgs>, path: string): string {
  if (flagText(args, "management-group")) {
    invalid("rule creation requires one subscription, not a management group", path);
  }
  const subs = flagList(args, "subscription");
  if (subs?.length !== 1 || !GUID.test(subs[0]!)) {
    invalid("rule creation requires exactly one explicit subscription ID", path);
  }
  return subs[0]!;
}

/** One address/port list flag, defaulting to `*` like az's source selectors. */
function selectorList(args: ReturnType<typeof parseArgs>, name: string, path: string): string[] {
  const list = flagList(args, name) ?? ["*"];
  if (!list.length) invalid(`flag --${name} needs a non-empty value`, path);
  return list;
}

function portRanges(args: ReturnType<typeof parseArgs>, name: string, path: string): string[] {
  const ranges = selectorList(args, name, path);
  for (const entry of ranges) {
    if (!PORT_ENTRY.test(entry)) invalid(`--${name} entry '${entry}' must be * or a port or range 0-65535`, path);
    if (entry === "*") continue;
    const [start, end = start] = entry.split("-").map(Number);
    if (start! > 65535 || end! > 65535 || start! > end!) {
      invalid(`--${name} entry '${entry}' must be an ascending port or range 0-65535`, path);
    }
  }
  return ranges;
}

/** Singular ARM field for one value, plural for several. */
function ranged(values: string[], single: string, plural: string): Record<string, unknown> {
  return values.length === 1 ? { [single]: values[0] } : { [plural]: values };
}

function gateSelectorFlags(args: ReturnType<typeof parseArgs>): string {
  return ["profile", "tenant", "config"]
    .map((key) => (flagText(args, key) === undefined ? "" : formatFlagValue(key, flagText(args, key)!)))
    .filter(Boolean)
    .join(" ");
}

async function runNsgRuleCreate(
  profile: ReturnType<typeof profileFromArgs>,
  args: ReturnType<typeof parseArgs>,
  path: string,
): Promise<Record<string, unknown>> {
  const subscription = explicitSubscriptionId(args, path);
  const ids = flagText(args, "ids");
  const nsgName = flagText(args, "nsg-name");
  const groupFlag = flagText(args, "resource-group");
  if (ids && (nsgName || groupFlag)) {
    invalid("--ids selects the NSG itself; --nsg-name and --resource-group are not accepted with --ids", path);
  }
  let nsgPath: string;
  let nsgLabel: string;
  if (ids) {
    const id = ids.trim();
    if (/[?#%\\]/.test(id)) invalid("--ids requires an unescaped ARM NSG ID without a query or fragment", path);
    const match = NSG_ID.exec(id);
    if (!match || !GUID.test(match[1]!)) invalid("--ids must be one NSG ARM ID under Microsoft.Network/networkSecurityGroups", path);
    if (match[1]!.toLowerCase() !== subscription.toLowerCase()) invalid("--ids conflicts with --subscription <id>", path);
    nsgPath = id.replace(/\/+$/, "");
    nsgLabel = match[3]!;
  } else {
    if (!nsgName || !groupFlag) invalid("rule creation needs --nsg-name with --resource-group, or --ids <nsg-ARM-id>", path);
    nsgLabel = nsgName.trim();
    nsgPath = `/subscriptions/${subscription}/resourceGroups/${segment(groupFlag, "resource-group", path)}` +
      `/providers/Microsoft.Network/networkSecurityGroups/${segment(nsgLabel, "nsg-name", path)}`;
  }
  const selectors = gateSelectorFlags(args);
  const showCommand = [
    "az-axi network nsg show",
    selectors,
    ...(ids
      ? [formatFlagValue("ids", ids.trim())]
      : [formatFlagValue("name", nsgLabel), formatFlagValue("resource-group", groupFlag!.trim())]),
    formatFlagValue("subscription", subscription),
    "--full",
  ].filter(Boolean).join(" ");
  const rawName = flagText(args, "name");
  if (!rawName) invalid("rule creation needs --name <rule-name>", path);
  const ruleName = rawName.trim();
  segment(ruleName, "name", path);
  const priority = Number(flagText(args, "priority") ?? "");
  if (flagText(args, "priority") === undefined || !Number.isInteger(priority) || priority < 100 || priority > 4096) {
    invalid("--priority must be an integer 100-4096", path);
  }
  const directionKey = flagText(args, "direction")?.toLowerCase() ?? "inbound";
  if (!Object.hasOwn(NSG_RULE_DIRECTIONS, directionKey)) invalid("--direction must be Inbound or Outbound", path);
  const direction = NSG_RULE_DIRECTIONS[directionKey]!;
  if ((flagText(args, "access")?.toLowerCase() ?? "deny") !== "deny") {
    invalid("--access takes Deny alone; Allow rules are out of scope", path);
  }
  const protocolKey = flagText(args, "protocol")?.toLowerCase() ?? "*";
  if (!Object.hasOwn(NSG_RULE_PROTOCOLS, protocolKey)) invalid("--protocol must be Tcp, Udp, Icmp, Esp, Ah or *", path);
  const protocol = NSG_RULE_PROTOCOLS[protocolKey]!;
  const description = flagText(args, "description");
  if (description !== undefined && description.length > 140) invalid("--description is restricted to 140 chars", path);
  const sourceAddresses = selectorList(args, "source-address-prefixes", path);
  const sourcePorts = portRanges(args, "source-port-ranges", path);
  const destAddresses = selectorList(args, "destination-address-prefixes", path);
  const destPorts = portRanges(args, "destination-port-ranges", path);
  const timeoutMs = parseTimeoutFlag(flagText(args, "timeout"));
  const noWait = flagBool(args, "no-wait");
  const timeoutRaw = flagText(args, "timeout");
  const confirm = flagString(args, "confirm") || undefined;

  const rulePath = `${nsgPath}/securityRules/${encodeURIComponent(ruleName)}`;
  const shape = { resource: "arm" as const, method: "PUT", path: rulePath };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  // A deny rule can cut live traffic: without the destructive class the typed
  // --confirm below would never run, so a quieter policy is a bug, not a pass.
  if (cls !== "destructive") {
    throw new AxiError("refusing: NSG security-rule creation must classify as destructive", "READ_ONLY", [
      "This is an az-axi bug: the request class does not match the leaf effect",
    ]);
  }
  const execute = enforceGates(profile, shape, cls, { execute: flagBool(args, "execute"), confirm });

  const probed = await sendRequest<NsgItem>(profile, { method: "GET", path: nsgPath, apiVersion: NETWORK });
  const etag = probed.headers["etag"] ?? (typeof probed.body.etag === "string" ? probed.body.etag : undefined);
  const existing = (probed.body.properties?.securityRules ?? []).filter((rule) => !!rule && typeof rule === "object")
    .map((rule) => ({
      name: typeof rule.name === "string" ? rule.name : "",
      priority: typeof rule.properties?.priority === "number" ? rule.properties.priority : Number.NaN,
      direction: rule.properties?.direction ?? "",
      access: rule.properties?.access ?? "",
    }))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const nameHit = existing.find((rule) => rule.name.toLowerCase() === ruleName.toLowerCase());
  if (nameHit) {
    throw new AxiError(`refusing to overwrite existing rule '${nameHit.name}' on NSG '${nsgLabel}'`, "VALIDATION_ERROR", [
      "Rule updates and deletes are out of scope; choose an unused --name",
      `Run \`${showCommand}\` for the current rules`,
    ]);
  }
  const priorityHit = existing.find((rule) => rule.priority === priority);
  if (priorityHit) {
    throw new AxiError(`priority ${priority} is already used by rule '${priorityHit.name}' on NSG '${nsgLabel}'`, "VALIDATION_ERROR", [
      "Priorities must be unique per NSG; choose an unused --priority",
      `Run \`${showCommand}\` for the current rules`,
    ]);
  }

  const body = {
    name: ruleName,
    properties: {
      ...(description === undefined ? {} : { description }),
      protocol,
      ...ranged(sourcePorts, "sourcePortRange", "sourcePortRanges"),
      ...ranged(destPorts, "destinationPortRange", "destinationPortRanges"),
      ...ranged(sourceAddresses, "sourceAddressPrefix", "sourceAddressPrefixes"),
      ...ranged(destAddresses, "destinationAddressPrefix", "destinationAddressPrefixes"),
      access: "Deny",
      priority,
      direction,
    },
  };
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  if (fields?.some((field) => !NSG_RULE_ROW_FIELDS.includes(field))) {
    invalid(`rule create --fields supports only: ${NSG_RULE_ROW_FIELDS.join(", ")}`, path);
  }
  const limit = limitValue(args, path);
  const shown = pickFields(full ? existing : existing.slice(0, limit), fields);
  const scopeFlags = ids
    ? [formatFlagValue("ids", ids.trim())]
    : [formatFlagValue("nsg-name", nsgLabel), formatFlagValue("resource-group", groupFlag!.trim())];
  const listFlags = [
    ["source-address-prefixes", sourceAddresses], ["source-port-ranges", sourcePorts],
    ["destination-address-prefixes", destAddresses], ["destination-port-ranges", destPorts],
  ] as const;
  const command = () =>
    [
      "az-axi network nsg rule create",
      selectors,
      ...scopeFlags,
      formatFlagValue("name", ruleName),
      formatFlagValue("priority", String(priority)),
      formatFlagValue("direction", direction),
      formatFlagValue("access", "Deny"),
      formatFlagValue("protocol", protocol),
      ...listFlags.map(([flag, values]) => formatFlagValue(flag, values.join(","))),
      ...(description === undefined ? [] : [formatFlagValue("description", description)]),
      formatFlagValue("subscription", subscription),
      ...(timeoutRaw === undefined ? [] : [formatFlagValue("timeout", timeoutRaw)]),
      ...(noWait ? ["--no-wait"] : []),
      "--execute",
      formatFlagValue("confirm", ruleName),
    ]
      .filter(Boolean)
      .join(" ");
  const base = {
    dryRun: true,
    class: cls,
    method: "PUT",
    target: shortenResourceId(rulePath),
    subscription,
    nsg: nsgLabel,
    rule: body,
  };
  if (!execute) {
    return {
      ...base,
      existingRules: shown,
      totalRules: existing.length,
      ...(etag ? { etag } : {}),
      protection: NSG_RULE_PROTECTION,
      help: [
        ...(shown.length < existing.length && !full
          ? [`Run \`${showCommand}\` for every existing rule`]
          : []),
        `\`${command()}\``,
      ],
    };
  }
  return executeWrite({
    profile,
    method: "PUT",
    path: buildUrl({ path: rulePath, apiVersion: NETWORK }),
    cls: "destructive",
    body,
    isNoop: (current) => {
      if (current !== undefined) {
        throw new AxiError(`refusing to overwrite rule '${ruleName}' found before the PUT`, "CONFLICT", [
          `Run \`${showCommand}\` to review the current rules before retrying`,
        ]);
      }
      return false;
    },
    verify: async () => {
      let current: AnyObj;
      try {
        current = (await sendRequest<AnyObj>(profile, { method: "GET", path: rulePath, apiVersion: NETWORK })).body;
      } catch (error) {
        if (!(error instanceof AxiError)) throw error;
        throw new AxiError(`Rule PUT was sent, but the post-write read failed: ${error.message}`, "VERIFY_FAILED", [
          `Run \`${showCommand}\` to inspect the rule; do not retry the write without reviewing it`,
        ]);
      }
      const properties = { ...objOf(current.properties) };
      delete properties.provisioningState;
      if (!diffResource({ name: current.name, properties }, body, "PUT").noop) {
        throw new AxiError("Rule PUT was sent, but the rule read back does not match the rule sent", "CONFLICT", [
          `Run \`${showCommand}\` to inspect the rule; a concurrent change may have occurred`,
        ]);
      }
    },
    protection: NSG_RULE_PROTECTION,
    confirm,
    selectors,
    timeoutMs,
    noWait,
  });
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const positionalWords = args.positionals.slice(0, args.positionals[0] === "dns" ? 4 : args.positionals[0] === "nsg" && args.positionals[1] === "rule" ? 3 : 2);
  const verb = positionalWords[positionalWords.length - 1];
  const words = positionalWords.slice(0, -1);
  const path = `network ${words.join(" ")} ${verb}`;
  const isRecordSet = words[0] === "dns" && words[1] === "record-set";
  const recordType = isRecordSet && words.length === 3 ? words[2]!.toUpperCase() : undefined;
  if (recordType && !(NETWORK_RECORD_TYPES as readonly string[]).includes(words[2]!)) {
    invalid(`expected DNS record type ${NETWORK_RECORD_TYPES.join("|")}`, path);
  }
  if (isRecordSet && verb === "show" && !recordType) {
    invalid("record-set show needs a type subgroup, for example: network dns record-set a show", path);
  }
  // The network module stays read-effect; the rule-create verb elevates to
  // the destructive effect for its own requests only, as Sentinel does.
  if (words.join(" ") === "nsg rule") {
    if (verb !== "create" || args.positionals.length !== 3) {
      invalid("expected `network nsg rule create` with no other positional arguments", path);
    }
    assertKnownFlags(args, commandFlags(path), path, networkLeafHelp(path));
    const profile = profileFromArgs(args);
    return runWithEffect("destructive", () => runNsgRuleCreate(profile, args, path));
  }
  const collection = collectionFor(recordType ? words.slice(0, 2) : words, path);
  if (verb !== "list" && verb !== "show") {
    invalid("expected network nsg|nic|vnet|public-ip|private-endpoint list|show, network nsg rule create, dns zone list|show, or dns record-set [a|aaaa|caa|cname|mx|ns|ptr|soa|srv|txt] list|show", path);
  }
  if (args.positionals.length !== words.length + 1) {
    invalid(`unexpected argument \`${args.positionals[words.length + 1]}\` for \`${path}\``, path);
  }
  assertKnownFlags(args, commandFlags(path), path, networkLeafHelp(path));
  const profile = profileFromArgs(args);
  if (args.flags["management-group"] || profile.managementGroup && !args.flags.subscription && !process.env.AZ_AXI_SUBSCRIPTION?.trim()) {
    invalid("management-group scope is unsupported for network reads; select subscriptions explicitly", path);
  }
  return verb === "list"
    ? runList(profile, args, collection, path, recordType)
    : runShow(profile, args, collection, path, recordType);
}
