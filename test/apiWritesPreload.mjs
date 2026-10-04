// Offline built-CLI fixture. This replaces fetch completely, with no network fallback.
import { appendFileSync } from "node:fs";

const scenario = process.env.AZ_AXI_TEST_OUTCOME;
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
    incidentNumber,
  },
});

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
    if (scenario === "gone") return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
    if (new URL(url).pathname.includes("/alerts/")) return json({ properties: { status: process.env.AZ_AXI_TEST_ALERT_STATUS ?? "Active" } }, 200, { etag: '"fresh"' });
    const incidentsPath = new URL(url).pathname;
    if (incidentsPath.includes("/incidents/") || incidentsPath.endsWith("/incidents")) {
      const path = incidentsPath;
      // A comment that was never created reads back missing, so comment
      // previews report `creates: true` and executions skip the no-op check.
      // AZ_AXI_TEST_COMMENT_MESSAGE simulates re-reading an existing comment.
      if (path.includes("/comments/")) {
        const existing = process.env.AZ_AXI_TEST_COMMENT_MESSAGE;
        if (existing === undefined) return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
        return json({ properties: { message: existing } }, 200, { etag: '"fresh"' });
      }
      if (path.endsWith("/incidents")) {
        return json({ value: [incidentBody("00000000-0000-0000-0000-000000000063", 3177)] });
      }
      const name = path.split("/incidents/")[1].split("/")[0];
      return json(incidentBody(name, 3177), 200, { etag: '"fresh"' });
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
  if (scenario === "network") throw new Error("synthetic offline network failure");
  if (["async", "failure", "timeout", "no-wait", "location"].includes(scenario)) {
    return json({}, 202, { [scenario === "location" ? "location" : "azure-asyncoperation"]: operationUrl,
      "retry-after": scenario === "timeout" ? "1" : "0" });
  }
  if (scenario === "created") return json({}, 201);
  if (new URL(url).pathname.includes("/alerts/")) return new Response(null, { status: 204, headers: { "x-ms-request-id": "req-test", "x-ms-correlation-request-id": "corr-test" } });
  if (new URL(url).pathname.includes("/incidents/") && method === "PUT") {
    // A comment PUT against a missing incident surfaces the missing target.
    if (scenario === "gone") return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
    if (new URL(url).pathname.includes("/comments/")) return json({ properties: { message: "offline comment" } }, 201);
    return json(incidentBody("00000000-0000-0000-0000-000000000063", 3177));
  }
  return json({});
};
