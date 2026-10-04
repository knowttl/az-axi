export const NETWORK_RECORD_TYPES = ["a", "aaaa", "caa", "cname", "mx", "ns", "ptr", "soa", "srv", "txt"] as const;

const SELECTORS: Record<string, string> = {
  "network nsg list": "--resource-group / -g scopes the list; --name / -n filters one exact NSG name.",
  "network nsg show": "--name / -n with --resource-group / -g in one subscription, or --ids <nsg-ARM-id> alone.",
  "network nic list": "--resource-group / -g scopes the list; --name / -n filters one exact NIC name.",
  "network nic show": "--name / -n with --resource-group / -g in one subscription, or --ids <nic-ARM-id> alone.",
  "network vnet list": "--resource-group / -g scopes the list; --name / -n filters one exact VNet name.",
  "network vnet show": "--name / -n with --resource-group / -g in one subscription, or --ids <vnet-ARM-id> alone.",
  "network public-ip list": "--resource-group / -g scopes the list; --name / -n filters one exact address name.",
  "network public-ip show": "--name / -n with --resource-group / -g in one subscription, or --ids <address-ARM-id> alone.",
  "network private-endpoint list": "--resource-group / -g scopes the list; --name / -n filters one exact endpoint name.",
  "network private-endpoint show": "--name / -n with --resource-group / -g in one subscription, or --ids <endpoint-ARM-id> alone.",
  "network dns zone list": "--resource-group / -g scopes the list; --name / -n filters one exact zone name.",
  "network dns zone show": "--name / -n with --resource-group / -g in one subscription, or --ids <zone-ARM-id> alone.",
  "network dns record-set list": "Requires --zone-name with --resource-group / -g; a type subgroup filters one type, --name / -n filters one record name.",
  "network dns record-set show": "--zone-name with --resource-group / -g and --name / -n, or --ids <record-set-ARM-id> of the selected type alone.",
};

const DETAIL: Record<string, string> = {
  "network nsg list": "Rows default to name, id, location and rules (the custom security-rule count). Azure default security rules are excluded, including with --full.",
  "network nsg show": "Show returns custom security rules (name, priority, direction, access, protocol, source, destination, ports) plus attached subnets and NICs; long rule lists are capped at --limit with totalRules counting all custom rules. Azure default security rules are excluded; --full expands every custom rule.",
  "network nic list": "Rows default to name, id, location, privateIp and vm (the attached virtual machine, when any).",
  "network nic show": "Show returns every IP configuration (private IP, allocation, subnet, public IP) plus the NSG, virtual machine and MAC address.",
  "network vnet list": "Rows default to name, id, location, prefixes (address space) and subnets (the subnet count).",
  "network vnet show": "Show returns the address space, every subnet (prefix, NSG, route table) and every peering (state, remote VNet).",
  "network public-ip list": "Rows default to name, id, location, address and associated (the attached NIC, load balancer or gateway, including a NAT gateway, when any).",
  "network public-ip show": "Show returns the address, allocation method, association, FQDN, SKU and zones.",
  "network private-endpoint list": "Rows default to name, id, location, service (the target private-link service) and status (the connection state).",
  "network private-endpoint show": "Show returns the target service, connection state, subnet, NICs and custom DNS configs.",
  "network dns zone list": "Rows default to name, id, records (the record-set count) and nameServers (the name-server count).",
  "network dns zone show": "Show returns the record-set counts and every name server.",
  "network dns record-set list": "Rows default to name, type, ttl and target. The all-types record-set list and typed record-set a|aaaa|caa|cname|mx|ns|ptr|soa|srv|txt list follow Azure CLI grammar.",
  "network dns record-set show": "Show returns the TTL, FQDN and every routed value for the selected type subgroup.",
};

const FIELDS: Record<string, string> = {
  "network nsg list": "--fields: name, id, location, rules.",
  "network nsg show": "--fields: name, id, location, rules, totalRules, subnets, nics, tags, provisioningState.",
  "network nic list": "--fields: name, id, location, privateIp, vm.",
  "network nic show": "--fields: name, id, location, mac, nsg, vm, ipConfigs, totalIpConfigs, tags, provisioningState, enableIPForwarding, dnsLabel.",
  "network vnet list": "--fields: name, id, location, prefixes, subnets.",
  "network vnet show": "--fields: name, id, location, addressSpace, subnets, totalSubnets, peerings, totalPeerings, tags, provisioningState, dnsServers.",
  "network public-ip list": "--fields: name, id, location, address, associated.",
  "network public-ip show": "--fields: name, id, location, address, allocation, version, associated, fqdn, sku, zones, tags, provisioningState, idleTimeout.",
  "network private-endpoint list": "--fields: name, id, location, service, status.",
  "network private-endpoint show": "--fields: name, id, location, service, status, statusDescription, subnet, nics, dns, tags, provisioningState, groupIds.",
  "network dns zone list": "--fields: name, id, records, nameServers.",
  "network dns zone show": "--fields: name, id, location, records, maxRecords, nameServers, tags.",
  "network dns record-set list": "--fields: name, type, ttl, target.",
  "network dns record-set show": "--fields: name, id, type, ttl, fqdn, records, metadata.",
};

const FULL: Record<string, string> = {
  "network public-ip list": "--fields selects listed fields and takes precedence over --full; --full shows every fetched row. No view returns secrets, keys or credential fields.",
  "network public-ip show": "--fields selects listed fields and takes precedence over --full; --full expands safe metadata (tags, provisioningState, idleTimeout). No view returns secrets, keys or credential fields.",
};

export const NSG_RULE_CREATE_HELP = [
  "Command: az-axi network nsg rule create",
  "az-axi network nsg rule create --nsg-name <nsg> --resource-group / -g <group> --name / -n <rule> --priority <100-4096> --subscription / -s <id> [--direction Inbound|Outbound] [--access Deny] [--protocol Tcp|Udp|Icmp|Esp|Ah|*] [--source-address-prefixes ...] [--source-port-ranges ...] [--destination-address-prefixes ...] [--destination-port-ranges ...] [--description <text>] [--ids <nsg-ARM-id>] [--execute --confirm <rule>] [--timeout <seconds>] [--no-wait]",
  "Adds one Deny security rule to one existing network security group through one child PUT .../networkSecurityGroups/{nsg}/securityRules/{rule} (api-version 2024-05-01). Destructive: a deny rule can cut live traffic, so execution needs --confirm <rule-name> on top of every write gate.",
  "--subscription / -s requires a single explicit subscription ID; names and implicit env/profile scope are not accepted. Select the NSG with --nsg-name plus --resource-group / -g, or with --ids <nsg-ARM-id> alone (then --name still names the new rule). --management-group scope is unsupported.",
  "--name / -n names the new rule and --priority takes one integer 100-4096; when either already exists on the NSG the command refuses instead of overwriting. Rule updates and deletes stay out of scope: there is no rule mutation command.",
  "--access takes Deny alone and defaults to Deny; Allow is refused. --direction defaults to Inbound. --protocol defaults to *. The four address/port lists default to *; unlike az, the destination-port default is * rather than 80. Application security groups (--source-asgs/--destination-asgs) are unsupported and rejected as unknown flags.",
  "Writes require the existing profile permission and subscription allowlist. Default: dry run listing the NSG's existing rules plus the exact rule to be added; --execute checks rule absence and sends one child PUT. Ports must be 0-65535 and ranges ascending. Multiple address values require IP addresses or CIDR prefixes; service tags and * must be used alone. --timeout defaults to 600 seconds; --no-wait defaults to false. The shared write log, LRO handling and approval hook apply.",
  "Best effort: Azure's documented API cannot rule out a concurrent create of the same rule name in the seconds between preview and execution; such a rule can be overwritten. No conditional header is sent; --if-match is unsupported. Immediate readback compares rule name and writable properties, excluding service metadata, and reports mismatches or failed reads, including with --no-wait; matching readback does not prove absence of an overwrite.",
  "Owner-run live check: use an isolated NSG to create the same rule name concurrently between the existence check and PUT, then inspect overwrite behavior and post-write readback. Offline tests do not perform this check.",
  "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --help / -h.",
  "Examples: az-axi network nsg rule create --nsg-name nsg-web -g rg-demo -n deny-telnet --priority 400 --destination-port-ranges 23 --protocol Tcp -s <subscription>",
  "az-axi network nsg rule create --ids <nsg-ARM-id> -n deny-telnet --priority 400 --direction Outbound -s <subscription> --execute --confirm deny-telnet",
].join("\n");

export function networkLeafHelp(path: string): string {
  if (path === "network nsg rule create") return NSG_RULE_CREATE_HELP;
  const show = path.endsWith(" show");
  const key = path.replace(/^(network dns record-set) [^ ]+ (list|show)$/, "$1 $2");
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${SELECTORS[key] ?? ""}`.trimEnd(),
    "Read-only ARM GETs against Microsoft.Network: NSGs, NICs, VNets, public IPs and private endpoints use api-version 2024-05-01; public DNS zones and record sets use api-version 2018-05-01. Effective security rules, effective routes, Network Watcher diagnostics, DNSSEC keys, private DNS zones and any mutation stay out of scope.",
    "Lists fan out across the selected subscriptions (flags, environment, profile, else all accessible) with --resource-group / -g scoping and exact --name / -n filtering. --limit defaults to 50; --full shows every fetched row. Lists follow up to 100 pages per subscription and disclose incomplete counts as lower bounds.",
    "Show by name needs exactly one subscription; --ids takes exactly one ARM ID of the same collection and uses the ID's subscription when no scope is configured. --management-group scope is unsupported; select subscriptions explicitly.",
    DETAIL[key] ?? "",
    FULL[key] ?? "--fields selects listed fields and takes precedence over --full; --full expands safe metadata (tags, provisioningState, SKU details) and shows every fetched row. No view returns secrets, keys or credential fields.",
    FIELDS[key] ?? "",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path}${show ? " --ids <ARM-id> --full" : key === "network dns record-set list" ? " --zone-name <zone> --resource-group <rg>" : ""}`,
  ].join("\n");
}

export const NETWORK_HELP = [
  "az-axi network nsg list|show",
  "az-axi network nsg rule create --nsg-name <nsg> --resource-group <group> --name <rule> --priority <100-4096> --subscription <id>",
  "az-axi network nic list|show",
  "az-axi network vnet list|show",
  "az-axi network public-ip list|show",
  "az-axi network private-endpoint list|show",
  "az-axi network dns zone list|show",
  "az-axi network dns record-set list",
  `az-axi network dns record-set ${NETWORK_RECORD_TYPES.join("|")} list|show`,
  networkLeafHelp("network nsg show"),
].join("\n");
