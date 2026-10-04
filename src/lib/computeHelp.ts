const SELECTORS: Record<string, string> = {
  "vm list": "--resource-group / -g scopes the list; --name / -n filters one exact VM name.",
  "vm show": "--name / -n with --resource-group / -g in one subscription, or --ids <vm-ARM-id> alone.",
  "vm get-instance-view": "--name / -n with --resource-group / -g in one subscription, or --ids <vm-ARM-id> alone.",
  "vmss list": "--resource-group / -g scopes the list; --name / -n filters one exact scale-set name.",
  "vmss show": "--name / -n with --resource-group / -g in one subscription, or --ids <scale-set-ARM-id> alone.",
  "vmss get-instance-view": "--name / -n with --resource-group / -g in one subscription, or --ids <scale-set-ARM-id> alone.",
  "disk list": "--resource-group / -g scopes the list; --name / -n filters one exact disk name.",
  "disk show": "--name / -n with --resource-group / -g in one subscription, or --ids <disk-ARM-id> alone.",
};

const DETAIL: Record<string, string> = {
  "vm list": "Rows default to name, location, size, os and provisioning (the model provisioning state). List rows carry no live power state: run show or get-instance-view for the power state from the instance view.",
  "vm show": "Show reads the VM model with $expand=instanceView in one GET and returns size, OS, image, disks and NICs with the live power and provisioning states taken from the instance-view statuses. Admin passwords, custom data, secrets, user data and boot-diagnostic blob URIs are never requested or printed; only the computer name is projected from the OS profile. VM start, stop, restart, deallocate, redeploy, reimage and run-command actions stay out.",
  "vm get-instance-view": "Show returns the runtime view: live power and provisioning states, OS name and version, agent version, fault and update domains, per-disk statuses and per-extension statuses. Data-disk and extension rows are capped at --limit with totals disclosed; --full shows every nested row. Boot-diagnostic blob URIs, patch details and maintenance status stay out.",
  "vmss list": "Rows default to name, location, SKU, capacity, orchestration (Uniform or Flexible) and provisioning state.",
  "vmss show": "Show returns the SKU and capacity, orchestration mode, upgrade-policy mode, computer-name prefix, image reference and zones. Admin passwords, custom data and secrets are never printed; only the computer-name prefix is projected from the OS profile. Use get-instance-view for aggregate runtime state. Per-VM-instance reads and scale-set start, stop, restart, deallocate, reimage and run-command actions stay out.",
  "vmss get-instance-view": "One GET returns aggregate runtime state: statuses (code, displayStatus, level) and vmStatuses (code, count for VMs with that status). Each array is capped at --limit with its total row count disclosed; --full shows every row. Status messages, extension details, per-VM-instance reads and all actions stay out.",
  "disk list": "Rows default to name, location, size in GiB, SKU, state (Attached, Unattached, Reserved and SAS states are names only) and OS type.",
  "disk show": "Show returns the size, SKU, state, OS type and attachment (the owning VM or disk, when any). Grant-access SAS URIs and export actions are never called; only the disk state name is printed. Disk create, update, delete, grant and revoke actions stay out.",
};

const FIELDS: Record<string, string> = {
  "vm list": "--fields: name, location, size, os, provisioning.",
  "vm show": "--fields: name, location, size, os, power, provisioning, id, computer, image, osDisk, dataDisks, totalDataDisks, nics, zone, availabilitySet, tags.",
  "vm get-instance-view": "--fields: name, power, provisioning, os, agent, computer, faultDomain, updateDomain, disks, totalDisks, extensions, totalExtensions.",
  "vmss list": "--fields: name, location, sku, capacity, orchestration, provisioning.",
  "vmss show": "--fields: name, location, sku, capacity, orchestration, provisioning, upgradeMode, computerPrefix, image, osType, zones, tags.",
  "vmss get-instance-view": "--fields: name, statuses, totalStatuses, vmStatuses, totalVmStatuses.",
  "disk list": "--fields: name, location, sizeGb, sku, state, os.",
  "disk show": "--fields: name, location, sizeGb, sku, state, os, attached, id, timeCreated, encryption, networkAccess, zones, tags, provisioningState.",
};

export function computeLeafHelp(path: string): string {
  const show = path.endsWith(" show") || path.endsWith("get-instance-view");
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${SELECTORS[path] ?? ""}`.trimEnd(),
    "Read-only ARM GETs against Microsoft.Compute: virtual machines and scale sets use api-version 2024-11-01; managed disks use api-version 2024-03-02. VM/VMSS/disk actions (start, stop, restart, deallocate, grant-access) and image, snapshot, restore-point, gallery and host resources stay out of scope.",
    "Lists fan out across the selected subscriptions (flags, environment, profile, else all accessible) with --resource-group / -g scoping and exact --name / -n filtering. --limit defaults to 50; --full shows every fetched row. Lists follow up to 100 pages per subscription and disclose incomplete counts as lower bounds.",
    "Show by name needs exactly one subscription; --ids takes exactly one ARM ID of the same collection and uses the ID's subscription when no scope is configured. --management-group scope is unsupported; select subscriptions explicitly.",
    DETAIL[path] ?? "",
    "--fields selects listed fields and takes precedence over --full; --full expands safe metadata (tags, zones, provisioning state) and shows every fetched row. No view returns secrets, keys, passwords, custom data, user data, SAS URIs or credential fields.",
    FIELDS[path] ?? "",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path}${show ? " --ids <ARM-id> --full" : ""}`,
  ].join("\n");
}

export const VM_HELP = [
  "az-axi vm list|show|get-instance-view",
  computeLeafHelp("vm list"),
  computeLeafHelp("vm show"),
  computeLeafHelp("vm get-instance-view"),
].join("\n");

export const VMSS_HELP = [
  "az-axi vmss list|show|get-instance-view",
  computeLeafHelp("vmss list"),
  computeLeafHelp("vmss show"),
  computeLeafHelp("vmss get-instance-view"),
].join("\n");

export const DISK_HELP = [
  "az-axi disk list|show",
  computeLeafHelp("disk list"),
  computeLeafHelp("disk show"),
].join("\n");
