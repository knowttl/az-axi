import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acrCatalog, acrDigest, acrManifest, acrTags } from "./samples.js";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-acr-cli-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: { ci: { auth: "token", password: "hostile-password" } } }));
  writeFileSync(join(dir, "config"), "[acr]\nusername=hostile-user\npassword=hostile-password\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function cli(argv: string[], forbidFetch = false, missingToken = false) {
  const stub = `globalThis.fetch=async(url,init)=>{const u=String(url);if(${forbidFetch}||!u.startsWith('https://myregistry.azurecr.io/')||init.redirect!=='error')throw Error('unexpected transport');if(u.endsWith('/oauth2/exchange')){if(init.method!=='POST')throw Error('unexpected transport');return new Response(${JSON.stringify(JSON.stringify({ refresh_token: "offline-refresh" }))});}if(u.endsWith('/oauth2/token')){if(init.method!=='POST'||!String(init.body).includes('refresh_token=offline-refresh'))throw Error('unexpected transport');return new Response(${JSON.stringify(JSON.stringify({ access_token: "offline-access" }))});}if(init.method!=='GET'||init.headers.Authorization!=='Bearer offline-access')throw Error('unexpected transport');if(u.includes('/_catalog'))return new Response(${JSON.stringify(JSON.stringify(acrCatalog))});if(u.includes('/_tags'))return new Response(${JSON.stringify(JSON.stringify(acrTags))});if(u.includes('/manifests/'))return new Response(${JSON.stringify(JSON.stringify(acrManifest))},{headers:${JSON.stringify({ "Docker-Content-Digest": acrDigest })}});throw Error('unexpected transport');};`;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, "dist/bin/az-axi.js", ...argv], {
    encoding: "utf8", env: { ...process.env, AZ_AXI_CONFIG: join(dir, "config.json"), AZ_AXI_PROFILE: "ci", AZ_AXI_REGISTRY_TOKEN: missingToken ? "" : "offline-entra-token", AZURE_CONFIG_DIR: dir,
      AZURE_STORAGE_AUTH_MODE: "key", AZURE_STORAGE_KEY: "hostile-key", AZ_AXI_READ_ONLY: "1" },
  });
}
const LEAVES: Array<{ argv: string[]; expect: string }> = [
  { argv: ["acr", "repository", "list", "--name", "myregistry"], expect: "hello-world" },
  { argv: ["acr", "repository", "show-tags", "--name", "myregistry", "--repository", "hello-world"], expect: acrDigest },
  { argv: ["acr", "manifest", "show-metadata", "--registry", "myregistry", "--name", "hello-world:latest"], expect: "mediaType" },
];
describe("built acr CLI offline", () => {
  it.each(LEAVES)("$argv emits TOON metadata without credentials or local files", ({ argv, expect: text }) => {
    const result = cli(argv);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("registry: myregistry");
    expect(result.stdout).toContain(text);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/offline-entra-token|offline-refresh|offline-access|hostile-password|never-output-this-value/);
    expect(readdirSync(dir).sort()).toEqual(["config", "config.json"]);
  });
  it.each([["--username", "user"], ["--password", "secret"], ["--suffix", "tenant"], ["--image", "hello-world:latest"], ["--file", "download"], ["--detail", "true"], ["--execute"], ["--top", "10"], ["--limit", "0"]])("refuses hostile flags %j before fetch", (...flags) => {
    const result = cli(["acr", "repository", "show-tags", "--name", "myregistry", "--repository", "hello-world", ...flags], true);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("unexpected transport");
    expect(readdirSync(dir).sort()).toEqual(["config", "config.json"]);
  });
  it.each([["acr", "repository", "delete", "--name", "myregistry", "--repository", "hello-world"], ["acr", "manifest", "delete", "--registry", "myregistry", "--name", "hello-world:latest"], ["az", "acr", "login", "--name", "myregistry"]])("refuses write and login paths %j without transport", (...argv) => {
    const result = cli(argv, true);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("unexpected transport");
  });
  it("missing registry token never exchanges or falls back to passwords", () => {
    const result = cli(["acr", "repository", "list", "--name", "myregistry"], true, true);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("code: AUTH_REQUIRED");
    expect(result.stdout).toContain("AZ_AXI_REGISTRY_TOKEN");
  });
});
