// Offline built-CLI fixture. This replaces fetch completely, with no network fallback.
import { appendFileSync } from "node:fs";

const scenario = process.env.AZ_AXI_TEST_OUTCOME;
let incidentReads = 0;
let tagReads = 0;
const operationUrl = "https://management.azure.com/operations/test?api-version=1";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "x-ms-request-id": "req-test", "x-ms-correlation-request-id": "corr-test", ...headers },
});

// Synthetic Sentinel incident shaped like the 2025-09-01 contract. Status,
// severity and classification follow the test environment so previews,
// no-op detection and conflict scenarios stay deterministic.
const incidentBody = (name, incidentNumber) => ({
  id: `/subscriptions/00000000-0000-0000-0000-000000000021/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces/logs-demo/providers/Microsoft.SecurityInsights/incidents/${name}`,
  name,
  type: "Microsoft.SecurityInsights/incidents",
  etag: '"fresh"',
  properties: {
    title: "Offline incident",
    status: process.env.AZ_AXI_TEST_INCIDENT_STATUS ?? "Active",
    severity: process.env.AZ_AXI_TEST_INCIDENT_SEVERITY ?? "High",
    classification: process.env.AZ_AXI_TEST_INCIDENT_CLASSIFICATION ?? "Undetermined",
    ...(process.env.AZ_AXI_TEST_INCIDENT_OWNER === undefined ? {} : { owner: JSON.parse(process.env.AZ_AXI_TEST_INCIDENT_OWNER) }),
    ...(process.env.AZ_AXI_TEST_INCIDENT_DESCRIPTION === undefined ? {} : { description: process.env.AZ_AXI_TEST_INCIDENT_DESCRIPTION }),
    incidentNumber,
  },
});

// Synthetic TagsResource shaped like the 2021-04-01 contract. The tag map
// follows AZ_AXI_TEST_TAGS so tag previews, no-op detection and delete
// scenarios stay deterministic; AZ_AXI_TEST_TAGS_MISSING=1 simulates a scope
// with no tags wrapper yet (merge creates it, delete is a no-op).
const tagsBody = () => ({
  id: "https://management.azure.com/tags/default",
  name: "default",
  type: "Microsoft.Resources/tags",
  properties: { tags: JSON.parse(process.env.AZ_AXI_TEST_TAGS ?? '{"env":"dev"}') },
});

const tagsMissing = () => process.env.AZ_AXI_TEST_TAGS_MISSING === "1" || scenario === "gone";

const tagsGet = () => {
  tagReads += 1;
  if (tagReads > 1 && process.env.AZ_AXI_TEST_TAGS_FRESH !== undefined) {
    const tags = JSON.parse(process.env.AZ_AXI_TEST_TAGS_FRESH);
    if (tags === null) return json({ error: { code: "ResourceNotFound", message: "no tags yet" } }, 404);
    return json({ ...tagsBody(), properties: { tags } }, 200, { etag: '"tags2"' });
  }
  if (tagsMissing()) return json({ error: { code: "ResourceNotFound", message: "no tags yet" } }, 404);
  return json(tagsBody(), 200, { etag: '"tags1"' });
};

// Synthetic NSG shaped like the 2024-05-01 contract. The custom rule list
// follows AZ_AXI_TEST_NSG_RULES so previews, name/priority conflicts and the
// execute-time race stay deterministic; AZ_AXI_TEST_NSG_MISSING=1 simulates a
// missing NSG, and AZ_AXI_TEST_NSG_RULE_EXISTS=1 makes the rule GET find a
// rule the preview did not see (creation must then refuse, never overwrite).
const nsgRules = () => {
  if (process.env.AZ_AXI_TEST_NSG_RULES !== undefined) return JSON.parse(process.env.AZ_AXI_TEST_NSG_RULES);
  return [
    { name: "allow-https", properties: { protocol: "Tcp", access: "Allow", priority: 100, direction: "Inbound",
      sourcePortRange: "*", destinationPortRange: "443", sourceAddressPrefix: "Internet", destinationAddressPrefix: "*" } },
    { name: "deny-ssh", properties: { protocol: "*", access: "Deny", priority: 200, direction: "Inbound",
      sourcePortRange: "*", destinationPortRange: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*" } },
  ];
};

const nsgBody = (nsgName) => ({
  id: `/subscriptions/00000000-0000-0000-0000-000000000021/resourceGroups/rg-demo/providers/Microsoft.Network/networkSecurityGroups/${nsgName}`,
  name: nsgName,
  type: "Microsoft.Network/networkSecurityGroups",
  location: "westus",
  etag: '"nsg1"',
  properties: { provisioningState: "Succeeded", securityRules: nsgRules() },
});

const nsgNameOf = (pathname) => decodeURIComponent(pathname.split("/networkSecurityGroups/")[1].split("/")[0]);
const ruleNameOf = (pathname) => decodeURIComponent(pathname.split("/securityRules/")[1].split("/")[0]);

const nsgGet = (pathname) => {
  if (process.env.AZ_AXI_TEST_NSG_MISSING === "1" || scenario === "gone") {
    return json({ error: { code: "ResourceNotFound", message: "no such NSG" } }, 404);
  }
  if (pathname.includes("/securityRules/")) {
    if (process.env.AZ_AXI_TEST_NSG_RULE_EXISTS === "1") {
      const name = ruleNameOf(pathname);
      return json({ id: `https://management.azure.com${pathname.split("?")[0]}`, name,
        type: "Microsoft.Network/networkSecurityGroups/securityRules", etag: '"rule1"',
        properties: { access: "Deny", priority: 400, direction: "Inbound", protocol: "Tcp" } }, 200, { etag: '"rule1"' });
    }
    return json({ error: { code: "ResourceNotFound", message: "no such rule" } }, 404);
  }
  return json(nsgBody(nsgNameOf(pathname)), 200, { etag: '"nsg1"' });
};

const nsgRulePut = (url, body) => {
  const pathname = new URL(url).pathname;
  const ruleUrl = `https://management.azure.com${pathname}`;
  return json({ id: ruleUrl, name: ruleNameOf(pathname),
    type: "Microsoft.Network/networkSecurityGroups/securityRules", etag: '"rule1"',
    properties: { ...(body?.properties ?? {}), provisioningState: "Succeeded" } }, 201);
};

const tagsPatch = (body) => {
  if (scenario === "gone") return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
  const sent = body?.properties?.tags ?? {};
  const current = tagReads > 1 && process.env.AZ_AXI_TEST_TAGS_FRESH !== undefined
    ? JSON.parse(process.env.AZ_AXI_TEST_TAGS_FRESH) ?? {}
    : process.env.AZ_AXI_TEST_TAGS_MISSING === "1" ? {} : tagsBody().properties.tags;
  const selected = new Map(Object.entries(sent).map(([key, value]) => [key.toLowerCase(), value]));
  const currentNames = new Map(Object.keys(current).map((key) => [key.toLowerCase(), key]));
  const tags = body?.operation === "Delete"
    ? Object.fromEntries(Object.entries(current).filter(([key, value]) =>
      !selected.has(key.toLowerCase()) ||
      (selected.get(key.toLowerCase()) !== null && selected.get(key.toLowerCase()) !== value)))
    : Object.fromEntries([
      ...Object.entries(current),
      ...Object.entries(sent).map(([key, value]) => [currentNames.get(key.toLowerCase()) ?? key, value]),
    ]);
  return json({ id: "https://management.azure.com/tags/default", name: "default",
    type: "Microsoft.Resources/tags", properties: { tags } });
};

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  let body;
  if (process.env.AZ_AXI_TEST_CAPTURE_BODY === "1" && init.body !== undefined) {
    body = JSON.parse(init.body);
  }
  appendFileSync(process.env.AZ_AXI_TEST_REQUESTS, JSON.stringify({ method, ifMatch: init.headers?.["If-Match"],
    ...(process.env.AZ_AXI_TEST_CAPTURE_URL === "1" ? { url: String(url) } : {}),
    ...(body !== undefined ? { body } : {}) }) + "\n");
  if (new URL(url).pathname === "/operations/test") {
    return json({ status: scenario === "failure" ? "Failed" : "Succeeded", error: { code: "SyntheticFailure", message: "test failure" } });
  }
  if (method === "GET") {
    if (new URL(url).pathname.includes("/networkSecurityGroups/")) return nsgGet(new URL(url).pathname);
    if (scenario === "gone") return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
    if (new URL(url).pathname.endsWith("/tags/default")) return tagsGet();
    if (new URL(url).pathname.includes("/alerts/")) return json({ properties: { status: process.env.AZ_AXI_TEST_ALERT_STATUS ?? "Active" } }, 200, { etag: '"fresh"' });
    const incidentsPath = new URL(url).pathname;
    if (incidentsPath.includes("/incidents/") || incidentsPath.endsWith("/incidents")) {
      const path = incidentsPath;
      if (path.includes("/comments/")) {
        return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
      }
      if (path.endsWith("/incidents")) {
        return json({ value: [incidentBody("00000000-0000-0000-0000-000000000063", 3177)] });
      }
      const name = path.split("/incidents/")[1].split("/")[0];
      const incident = incidentBody(name, 3177);
      incidentReads += 1;
      if (scenario === "incident-race") {
        incident.etag = incidentReads === 1 ? '"E1"' : '"E2"';
        incident.properties.status = incidentReads === 1 ? "Active" : "Closed";
      }
      if (scenario === "review-stale") incident.etag = '"E2"';
      return json(incident, 200, { etag: incident.etag });
    }
    // Workspace alias resolution lists ARM workspaces and matches the
    // customer ID from the profile alias.
    if (new URL(url).pathname.endsWith("/workspaces")) {
      const guid = process.env.AZ_AXI_TEST_WORKSPACE_ID ?? "00000000-0000-0000-0000-000000000010";
      return json({ value: [{
        id: `/subscriptions/00000000-0000-0000-0000-000000000021/resourceGroups/rg-demo/providers/Microsoft.OperationalInsights/workspaces/logs-demo`,
        name: "logs-demo",
        properties: { customerId: guid },
      }] });
    }
    return json({ tags: { env: scenario === "noop" ? "prod" : "dev" } }, 200, { etag: '"fresh"' });
  }
  if (new URL(url).pathname.endsWith("/whatIf")) return json({ properties: { changes: [] } });
  if (scenario === "precondition") return json({ error: { code: "PreconditionFailed", message: "changed" } }, 412);
  if (method === "PATCH" && new URL(url).pathname.endsWith("/tags/default")) return tagsPatch(body);
  if (["incident-race", "review-stale"].includes(scenario) && init.headers?.["If-Match"] !== '"E2"') {
    return json({ error: { code: "PreconditionFailed", message: "changed" } }, 412);
  }
  if (scenario === "network") throw new Error("synthetic offline network failure");
  if (["async", "failure", "timeout", "no-wait", "location"].includes(scenario)) {
    return json({}, 202, { [scenario === "location" ? "location" : "azure-asyncoperation"]: operationUrl,
      "retry-after": scenario === "timeout" ? "1" : "0" });
  }
  if (scenario === "created") return json({}, 201);
  if (method === "PUT" && new URL(url).pathname.includes("/securityRules/")) return nsgRulePut(url, body);
  if (new URL(url).pathname.includes("/alerts/")) return new Response(null, { status: 204, headers: { "x-ms-request-id": "req-test", "x-ms-correlation-request-id": "corr-test" } });
  if (new URL(url).pathname.includes("/incidents/") && method === "PUT") {
    // A comment PUT against a missing incident surfaces the missing target.
    if (scenario === "gone") return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
    if (new URL(url).pathname.includes("/comments/")) return json({ properties: { message: "offline comment" } }, 201);
    return json(incidentBody("00000000-0000-0000-0000-000000000063", 3177));
  }
  return json({});
};
