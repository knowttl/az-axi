import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leafHelp, COMMAND_LEAVES, type CommandLeaf } from "../src/lib/registry.js";
import {
  SUB_A,
  denyAssignment, denyAssignments,
  managementLock, managementLocks,
  policyAssignment, policyAssignments,
  policyDefinition, policyDefinitions,
  policySetDefinition, policySetDefinitions,
  policyStateEnvelope, policyStates, subscriptionList,
} from "./samples.js";

describe("built CLI governance reads offline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "az-axi-governance-cli-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: {
      ci: { auth: "token", subscriptions: [SUB_A] },
    } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(argv: string[], mode = "normal") {
    const stub = `
      const data = ${JSON.stringify({
        policyAssignments, policyDefinitions, policySetDefinitions,
        policyStates, managementLocks, denyAssignments, subscriptionList,
      })};
      const envelope = (value, count) => ({ value, "@odata.count": count, "@odata.nextLink": null });
      const mode = ${JSON.stringify(mode)};
      if (mode === 'secrets') {
        for (const item of [...data.policyAssignments, ...data.policyDefinitions, ...data.policySetDefinitions]) {
          item.properties.parameters = {
            adminPassword: { type: 'String', value: 'private-password', defaultValue: 'private-default', allowedValues: ['private-allowed'] },
            deploymentInput: { type: 'secureString', defaultValue: 'private-secure-default', allowedValues: ['private-secure-allowed'] },
            region: { type: 'String', defaultValue: 'public-region', allowedValues: ['public-region'] },
          };
          item.properties.policyRule = { then: { effect: 'deployIfNotExists', details: { deployment: { properties: {
            parameters: { deploymentInput: { value: { field: 'private-supplied-object' } } }, template: {
              parameters: { deploymentInput: { type: 'secureObject', defaultValue: { field: 'private-object' }, allowedValues: [{ field: 'private-object-allowed' }] } },
              resources: [{ type: 'Microsoft.Resources/deployments', properties: {
                parameters: { nestedInput: { value: 'private-nested-string' } },
                template: { parameters: { nestedInput: { type: 'secureString' } } },
              } }],
          } } } } } };
          item.properties.policyDefinitions = [{ policyDefinitionId: ${JSON.stringify(policyDefinition.id)}, parameters: {
            clientSecret: { value: 'private-member-value', defaultValue: 'private-member-default', allowedValues: ['private-member-allowed'] },
          } }];
        }
      }
      const itemsFor = (path) => {
        if (path === '/subscriptions') return data.subscriptionList;
        if (path.endsWith('/policyAssignments')) return mode === 'empty' ? [] : data.policyAssignments;
        if (path.endsWith('/policyDefinitions')) return mode === 'empty' ? [] : data.policyDefinitions;
        if (path.endsWith('/policySetDefinitions')) return mode === 'empty' ? [] : data.policySetDefinitions;
        if (path.endsWith('/locks')) return mode === 'empty' ? [] : data.managementLocks;
        if (path.endsWith('/denyAssignments')) return mode === 'empty' ? [] : data.denyAssignments;
        return undefined;
      };
      globalThis.fetch = async (url, options) => {
        process.stderr.write(JSON.stringify({url, method: options.method}) + '\\n');
        const path = new URL(url).pathname;
        if (mode === 'denied' && path.includes('/providers/Microsoft.Authorization/')) {
          return Response.json({error:{code:'AuthorizationFailed',message:'Denied'}},{status:403});
        }
        if (path.includes('/queryResults')) {
          if (options.method !== 'POST') throw new Error('states query must POST');
          return Response.json(envelope(mode === 'empty' ? [] : data.policyStates, data.policyStates.length));
        }
        if (options.method !== 'GET') throw new Error('non-GET request');
        const items = itemsFor(path);
        if (items) return Response.json({value: items});
        const all = [...data.policyAssignments, ...data.policyDefinitions, ...data.policySetDefinitions,
          ...data.managementLocks, ...data.denyAssignments];
        const found = all.find((item) => item.id.toLowerCase() === path.toLowerCase());
        if (!found) return Response.json({error:{code:'NotFound',message:'Missing'}},{status:404});
        return Response.json(found);
      };
    `;
    const preload = `data:text/javascript,${encodeURIComponent(stub)}`;
    return spawnSync(process.execPath, ["--import", preload, "dist/bin/az-axi.js", ...argv], {
      encoding: "utf8",
      // Git Bash must pass ARM IDs to Node without converting them to Windows paths.
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*", AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_TENANT: "", AZ_AXI_SUBSCRIPTION: "", AZ_AXI_ARM_TOKEN: "offline-token", AZ_AXI_READ_ONLY: "1", AZ_AXI_USAGE_LOG: "0" },
    });
  }
  const group = ["--resource-group", "rg-demo"];

  it.each([
    { kind: "assignment", id: policyAssignment.id },
    { kind: "definition", id: policyDefinition.id },
    { kind: "set-definition", id: policySetDefinition.id },
  ])("keeps secret parameter contents out of compact and full $kind list and show output", ({ kind, id }) => {
    const compactList = run(["policy", kind, "list"], "secrets");
    const fullList = run(["policy", kind, "list", "--full"], "secrets");
    const compactShow = run(["policy", kind, "show", "--ids", id], "secrets");
    const fullShow = run(["policy", kind, "show", "--ids", id, "--full"], "secrets");
    expect(compactList.status, compactList.stdout).toBe(0);
    expect(fullList.status, fullList.stdout).toBe(0);
    expect(compactShow.status, compactShow.stdout).toBe(0);
    expect(fullShow.status, fullShow.stdout).toBe(0);
    expect(compactList.stdout).not.toContain("private-");
    expect(fullList.stdout).not.toContain("private-");
    expect(compactShow.stdout).not.toContain("private-");
    expect(fullShow.stdout).not.toContain("private-");
    expect((decode(fullList.stdout) as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    expect(JSON.parse((decode(fullShow.stdout) as { parameters: string }).parameters)).toEqual({
      adminPassword: { type: "String", value: "***redacted***", defaultValue: "***redacted***", allowedValues: "***redacted***" },
      deploymentInput: { type: "secureString", defaultValue: "***redacted***", allowedValues: "***redacted***" },
      region: { type: "String", defaultValue: "public-region", allowedValues: ["public-region"] },
    });
  });

  it("lists policy assignments and shows them by name and ARM ID", () => {
    const assignments = run(["policy", "assignment", "list", ...group]);
    expect(assignments.status, assignments.stdout).toBe(0);
    expect(assignments.stdout).toContain("TagEnforcement");
    expect(assignments.stdout).toContain("total: 2");
    expect(assignments.stderr).toContain("Microsoft.Authorization/policyAssignments?api-version=2021-06-01");
    const assignment = run(["policy", "assignment", "show", "--name", "TagEnforcement", ...group]);
    expect(assignment.status, assignment.stdout).toBe(0);
    expect(decode(assignment.stdout)).toMatchObject({ enforcement: "DoNotEnforce" });
    expect(run(["policy", "assignment", "show", "--ids", policyAssignment.id]).stdout).toContain("CostManagement");
  });

  it("lists policy definitions and shows their metadata by ARM ID", () => {
    const definitions = run(["policy", "definition", "list"]);
    expect(definitions.status, definitions.stdout).toBe(0);
    expect(definitions.stdout).toContain("Allowed storage account SKUs");
    expect(definitions.stderr).toContain("Microsoft.Authorization/policyDefinitions?api-version=2021-06-01");
    expect(run(["policy", "definition", "show", "--ids", policyDefinition.id]).stdout).toContain("BuiltIn");
    expect(decode(run(["policy", "definition", "show", "--ids", policyDefinition.id, "--fields", "version"]).stdout)).toMatchObject({ version: "1.2.1" });
  });

  it("lists policy initiatives and shows one by ARM ID", () => {
    const initiatives = run(["policy", "set-definition", "list"]);
    expect(initiatives.status, initiatives.stdout).toBe(0);
    expect(initiatives.stdout).toContain("Audit public network access");
    expect(run(["policy", "set-definition", "show", "--ids", policySetDefinition.id]).stdout).toContain("Network");
  });

  it("lists policy states with compliance aggregates and filtering", () => {
    const states = run(["policy", "state", "list", ...group]);
    expect(states.status, states.stdout).toBe(0);
    expect(states.stdout).toContain("NonCompliant");
    expect(states.stdout).toContain("total: 2");
    expect(states.stderr).toContain("Microsoft.PolicyInsights/policyStates/latest/queryResults");
    expect(states.stderr).toContain("api-version=2024-10-01");
    expect(decode(states.stdout)).toMatchObject({ byCompliance: { Compliant: 1, NonCompliant: 1 } });
    const filtered = run(["policy", "state", "list", "--compliance", "Compliant"]);
    expect(filtered.status, filtered.stdout).toBe(0);
    expect(decode(filtered.stdout)).toMatchObject({ total: 1 });
  });

  it("lists management locks with levels and scopes", () => {
    const locks = run(["lock", "list"]);
    expect(locks.status, locks.stdout).toBe(0);
    expect(locks.stdout).toContain("sub-lock");
    expect(locks.stderr).toContain("Microsoft.Authorization/locks?api-version=2020-05-01");
    expect(decode(locks.stdout)).toMatchObject({
      byLevel: { CanNotDelete: 1, ReadOnly: 1 },
      rows: [
        { name: "rg-lock", level: "ReadOnly", scope: `${SUB_A}/rg-demo` },
        { name: "sub-lock", level: "CanNotDelete", scope: SUB_A },
      ],
    });
  });

  it.each([
    { selector: "name", flags: ["--name", managementLock.name] },
    { selector: "ARM ID", flags: ["--ids", managementLock.id] },
  ])("shows management lock notes and owners by $selector", ({ flags }) => {
    const lock = run(["lock", "show", ...flags]);
    expect(lock.status, lock.stdout).toBe(0);
    expect(decode(lock.stdout)).toMatchObject({
      name: managementLock.name, level: "CanNotDelete", scope: `/subscriptions/${SUB_A}`,
      notes: "Protect the subscription from accidental deletion",
      owners: "00000000-0000-0000-0000-000000000030",
    });
  });

  it("lists deny assignments with separate permission planes", () => {
    const denies = run(["deny-assignment", "list"]);
    expect(denies.status, denies.stdout).toBe(0);
    expect(denies.stdout).toContain("deny-example");
    expect(denies.stderr).toContain("Microsoft.Authorization/denyAssignments?api-version=2022-04-01");
    expect(decode(denies.stdout)).toMatchObject({ rows: [
      { name: "deny-example", actions: "Microsoft.Storage/storageAccounts/write", dataActions: "" },
      { name: "sub-deny", actions: "*", dataActions: "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read" },
    ] });
  });

  it.each([
    { mode: "compact", flags: [] },
    { mode: "full", flags: ["--full"] },
    { mode: "selected", flags: ["--fields", "actions,dataActions,notActions,notDataActions,excludePrincipals"] },
  ])("shows excluded principals and separate deny permissions in $mode output", ({ flags }) => {
    const denied = run(["deny-assignment", "show", "--ids", denyAssignment.id, ...flags]);
    expect(denied.status, denied.stdout).toBe(0);
    expect(decode(denied.stdout)).toMatchObject({
      actions: ["Microsoft.Storage/storageAccounts/write"],
      dataActions: expect.any(Array), notActions: expect.any(Array), notDataActions: expect.any(Array),
      excludePrincipals: ["00000000-0000-0000-0000-000000000032"],
    });
    const sub = run(["deny-assignment", "show", "--name", "sub-deny", ...flags]);
    expect(sub.status, sub.stdout).toBe(0);
    expect(decode(sub.stdout)).toMatchObject({
      actions: ["*"],
      dataActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"],
      notActions: ["Microsoft.Resources/subscriptions/resourceGroups/read"],
      notDataActions: expect.any(Array),
    });
  });

  it("accepts short flags and filters definitions by type", () => {
    const short = run(["policy", "assignment", "list", "-g", "rg-demo", "-s", SUB_A]);
    expect(short.status, short.stdout).toBe(0);
    expect(short.stdout).toContain("total: 2");
    const named = run(["policy", "definition", "list", "-n", "ResourceNaming"]);
    expect(named.status, named.stdout).toBe(0);
    expect(named.stdout).toContain("Custom");
    expect(named.stdout).not.toContain("Allowed storage account SKUs");
  });

  it.each([
    { argv: ["policy", "assignment", "list", ...group], noun: "policy assignments" },
    { argv: ["policy", "state", "list", ...group], noun: "policy states" },
    { argv: ["lock", "list"], noun: "management locks" },
    { argv: ["deny-assignment", "list"], noun: "deny assignments" },
  ])("reports an explicit empty collection for $noun", ({ argv, noun }) => {
    const empty = run(argv, "empty");
    expect(empty.status, empty.stdout).toBe(0);
    expect(empty.stdout).toContain(`0 ${noun} found in subscription`);
  });

  it.each([
    ["policy", "assignment", "list", ...group],
    ["lock", "list"],
    ["lock", "show", "--ids", managementLock.id],
    ["deny-assignment", "list"],
    ["deny-assignment", "show", "--ids", denyAssignment.id],
  ])("reports access denial for %j", (...argv) => {
    const denied = run(argv, "denied");
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain("FORBIDDEN");
  });

  it.each([
    ["policy", "assignment", "update", ...group],
    ["policy", "assignment", "list", ...group, "--fields", "properties"],
    ["policy", "assignment", "show", "--name", "CostManagement", ...group, "--ids", policyAssignment.id],
    ["policy", "assignment", "show", "--ids", policyDefinition.id],
    ["policy", "definition", "list", "--resource-group", "rg-demo"],
    ["policy", "definition", "show", "--name", "ResourceNaming", ...group],
    ["policy", "definition", "show", "--ids", policyAssignment.id],
    ["policy", "set-definition", "show", "--ids", policyDefinition.id],
    ["policy", "state", "show"],
    ["policy", "state", "list", "--workspace", "x"],
    ["lock", "delete"],
    ["lock", "show", "--name", "sub-lock", "--ids", managementLock.id],
    ["lock", "show", "--ids", denyAssignment.id],
    ["deny-assignment", "create"],
    ["deny-assignment", "show", "--ids", managementLock.id],
  ])("refuses %j without governance transport", (...argv) => {
    const result = run(argv);
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toBe("");
  });

  it.each(COMMAND_LEAVES.filter((leaf: CommandLeaf) => leaf.path.startsWith("policy ") || leaf.path.startsWith("lock ") || leaf.path.startsWith("deny-assignment ")))("prints leaf help matching the registry without Azure access for $path", (leaf) => {
    const result = run([...leaf.path.split(" "), "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd()).toBe(leafHelp(leaf, leaf.path).trimEnd());
  });

  it("emits a runnable detail hint for the first row", () => {
    const list = run(["policy", "assignment", "list", ...group]);
    expect(list.status, list.stdout).toBe(0);
    const command = (decode(list.stdout) as { help: string[] }).help[0]!;
    expect(command).toContain("policy definition show --ids");
    const followed = run(command.split("`")[1]!.replace(/^az-axi /, "").split(" "));
    expect(followed.status, followed.stdout).toBe(0);
    expect(decode(followed.stdout)).toMatchObject({ type: "Custom" });
  });
});
