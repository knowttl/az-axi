import { readFileSync, writeFileSync } from "node:fs";
import { scrub } from "./scrub.mjs";

const mode = process.env.AZ_AXI_BENCH_MODE;
const file = process.env.AZ_AXI_BENCH_FILE;
if (!["record", "replay"].includes(mode) || !file) {
  throw new Error("Benchmark preload requires record|replay mode and AZ_AXI_BENCH_FILE");
}
const hosts = new Set(["management.azure.com", "api.loganalytics.io", "graph.microsoft.com"]);
const responses = mode === "replay" ? JSON.parse(readFileSync(file, "utf8")).responses : [];
const leakCheck = JSON.parse(process.env.AZ_AXI_BENCH_LEAK_CHECK ?? "[]");
const networkFetch = globalThis.fetch;
let cursor = 0;
let failed = false;

globalThis.fetch = async (input, init) => {
  try {
    const request = new Request(input, init);
    const host = new URL(request.url).host;
    const method = request.method;
    if (!hosts.has(host)) throw new Error("Benchmark request host is not allowed");
    const index = cursor++;
    if (mode === "replay") {
      const entry = responses[index];
      if (!entry || entry.host !== host || entry.method !== method) {
        throw new Error(`Benchmark replay mismatch at response ${index + 1}`);
      }
      const headers = entry.retryAfter === undefined ? {} : { "retry-after": String(entry.retryAfter) };
      return new Response(entry.body === null ? null : JSON.stringify(entry.body), { status: entry.status, headers });
    }
    // Only the owner capture runner authorizes network access. Never persist request headers or URLs.
    if (process.env.AZ_AXI_BENCH_OWNER_CAPTURE !== "1" || process.env.AZ_AXI_READ_ONLY !== "1") {
      throw new Error("Recording requires the owner capture runner in read-only mode");
    }
    const response = await networkFetch(request);
    const text = await response.clone().text();
    const body = scrub(text ? JSON.parse(text) : null, { leakCheck });
    const retryHeader = response.headers.get("retry-after");
    const retryAfter = retryHeader !== null && Number.isFinite(Number(retryHeader)) ? Number(retryHeader) : undefined;
    responses[index] = { method, host, status: response.status, body, ...(retryAfter === undefined ? {} : { retryAfter }) };
    return response;
  } catch (error) {
    failed = true;
    throw error;
  }
};

process.once("beforeExit", () => {
  if (failed || (mode === "replay" && cursor !== responses.length)) {
    process.stderr.write("Benchmark fetch failed or capture was not fully consumed\n");
    process.exitCode = 1;
  }
  if (mode === "record" && !process.exitCode) {
    const serialized = JSON.stringify({ responses }, null, 2);
    if (leakCheck.some((value) => serialized.toLowerCase().includes(value.toLowerCase()))) {
      throw new Error("Benchmark scrub failed: leakCheck string survived");
    }
    writeFileSync(file, `${serialized}\n`, { mode: 0o600 });
  }
});
