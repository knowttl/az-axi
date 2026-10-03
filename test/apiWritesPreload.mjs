// Offline built-CLI fixture. This replaces fetch completely, with no network fallback.
import { appendFileSync } from "node:fs";

const scenario = process.env.AZ_AXI_TEST_OUTCOME;
const operationUrl = "https://management.azure.com/operations/test?api-version=1";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "x-ms-request-id": "req-test", "x-ms-correlation-request-id": "corr-test", ...headers },
});

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  let body;
  if (process.env.AZ_AXI_TEST_CAPTURE_BODY === "1" && init.body !== undefined) {
    body = JSON.parse(init.body);
  }
  appendFileSync(process.env.AZ_AXI_TEST_REQUESTS, JSON.stringify({ method, ifMatch: init.headers?.["If-Match"],
    ...(body !== undefined ? { body } : {}) }) + "\n");
  if (new URL(url).pathname === "/operations/test") {
    return json({ status: scenario === "failure" ? "Failed" : "Succeeded", error: { code: "SyntheticFailure", message: "test failure" } });
  }
  if (method === "GET") {
    if (scenario === "gone") return json({ error: { code: "ResourceNotFound", message: "gone" } }, 404);
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
  return json({});
};
