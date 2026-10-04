import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storageBlobs, storageContainers, storageProperties } from "./samples.js";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-storage-cli-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", authMode: "key", accountKey: "hostile-key", sasToken: "sig=hostile", connectionString: "AccountKey=hostile" } } }));
  writeFileSync(join(dir, "config"), "[storage]\nauth_mode=key\nkey=hostile-key\nsas_token=sig=hostile\nconnection_string=AccountKey=hostile\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function cli(kind: string, verb: string, flags: string[] = [], forbidFetch = false, missingToken = false) {
  const body = kind === "blob" ? storageBlobs : storageContainers;
  const stub = `globalThis.fetch=async(url,init)=>{if(${forbidFetch}||!String(url).startsWith('https://stexample.blob.core.windows.net/')||init.redirect!=='error'||init.headers.Authorization!=='Bearer offline-storage-token'||init.method!==${JSON.stringify(verb === "show" ? "HEAD" : "GET")})throw Error('unexpected transport');return new Response(${verb === "show" ? "null" : JSON.stringify(body)},{headers:${JSON.stringify(storageProperties)}})};`;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, "dist/bin/az-axi.js", "storage", kind, verb, "--account-name", "stexample", ...(kind === "blob" ? ["--container-name", "example"] : []), ...(verb === "show" ? ["--name", "example"] : []), ...flags], {
    encoding: "utf8", env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_STORAGE_TOKEN: missingToken ? "" : "offline-storage-token", AZURE_CONFIG_DIR: dir,
      AZURE_STORAGE_AUTH_MODE: "key", AZURE_STORAGE_KEY: "hostile-key", AZURE_STORAGE_SAS_TOKEN: "sig=hostile", AZURE_STORAGE_CONNECTION_STRING: "AccountKey=hostile", AZURE_STORAGE_ACCOUNT: "hostileaccount", AZ_AXI_READ_ONLY: "1" },
  });
}
describe("built storage CLI offline", () => {
  it.each([["container", "list"], ["container", "show"], ["blob", "list"], ["blob", "show"]])("%s %s ignores hostile credential defaults and emits TOON properties", (kind, verb) => {
    const result = cli(kind!, verb!, ["--auth-mode", "login"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("account: stexample");
    expect(result.stdout).toContain("etag");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/offline-storage-token|hostile-key|never-output-this-value/);
    expect(readdirSync(dir).sort()).toEqual(["config", "config.json"]);
  });
  it.each([["--auth-mode", "key"], ["--account-key", "key"], ["--sas-token", "sig=hostile"], ["--connection-string", "AccountKey=hostile"], ["--file", "download"], ["--include", "metadata"], ["--fields", "metadata"], ["--auth-mode", "login", "--auth-mode", "key"]])("refuses hostile flags %j before fetch", (...flags) => {
    const result = cli("blob", "list", flags, true);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("unexpected transport");
    expect(readdirSync(dir).sort()).toEqual(["config", "config.json"]);
  });
  it("missing storage token never uses inherited keys", () => {
    const result = cli("container", "list", [], true, true);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: AUTH_REQUIRED");
    expect(result.stdout).toContain("AZ_AXI_STORAGE_TOKEN");
  });
});
