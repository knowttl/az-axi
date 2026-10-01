// Public-repo guard (plan Section 7.3). This repository is public: no real tenant,
// subscription, workspace, object or application IDs, and no real domains or hostnames.
// Scans every tracked text file (plus new files not yet ignored by git).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Synthetic identifiers: 00000000-0000-0000-0000-0000000000NN
const SYNTHETIC_GUID = /^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$/;

// Public, Microsoft-wide GUIDs that are required for function and are not tenant data.
// Built-in role definition IDs belong in src/lib/roles.ts and are imported from there, not listed here.
const PUBLIC_GUIDS: readonly string[] = [
  // Azure DevOps resource ID, a public Microsoft constant. It appears in the unmodified vendored
  // src/lib/auth.ts and is removed in Phase 1 when auth.ts is generalized.
  "499b84ac-1321-427f-aa17-267ca6975798",
];

// Documentation domains for synthetic examples (any subdomain is allowed).
const EXAMPLE_DOMAINS: readonly string[] = ["contoso.com", "fabrikam.com", "example.com"];

// Public hosts that docs, API endpoints, tooling and links legitimately name (any subdomain is allowed).
const PUBLIC_HOSTS: readonly string[] = [
  "azure.com",
  "github.com",
  "loganalytics.io",
  "microsoft.com",
  "microsoftonline.com",
  "nodejs.org",
  "npmjs.com",
  "npmjs.org",
  "semver.org",
  "toonformat.dev",
  "typescriptlang.org",
  "vitest.dev",
  "axi.md",
];

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico)$/i;

const GUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
// Hostnames: any URL host, plus bare lowercase names under TLDs that real tenants use.
// Common code words (".org", ".io", ".dev") and file names (".md", ".js") are only checked as URL hosts.
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g;
const BARE_HOST =
  /(?<![A-Za-z0-9@./_-])((?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|cloud|local|corp|internal|intranet|lan))(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;

function scannedFiles(): { path: string; lines: string[] }[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const files: { path: string; lines: string[] }[] = [];
  for (const path of listed.split("\0")) {
    if (path === "" || BINARY_EXTENSIONS.test(path)) continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue; // deleted in the working tree but still listed by git
    }
    if (text.includes("\0")) continue;
    files.push({ path, lines: text.split(/\r?\n/) });
  }
  return files;
}

function domainAllowed(host: string, allowed: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowed.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

function findings(check: (line: string) => string[]): string[] {
  const found: string[] = [];
  for (const { path, lines } of scannedFiles()) {
    lines.forEach((line, index) => {
      for (const token of check(line)) found.push(`${path}:${index + 1}: ${token}`);
    });
  }
  return found;
}

describe("public-repo identifier guard", () => {
  it("scans files", () => {
    expect(scannedFiles().length).toBeGreaterThan(0);
  });

  it("allows only synthetic or explicitly public GUIDs", () => {
    const bad = findings((line) =>
      [...line.matchAll(GUID)]
        .map((m) => m[0])
        .filter((guid) => !SYNTHETIC_GUID.test(guid) && !PUBLIC_GUIDS.includes(guid.toLowerCase())),
    );
    expect(bad).toEqual([]);
  });

  it("allows only example-domain email addresses", () => {
    const bad = findings((line) =>
      [...line.matchAll(EMAIL)]
        .filter((m) => !domainAllowed(m[1] ?? "", EXAMPLE_DOMAINS))
        .map((m) => m[0]),
    );
    expect(bad).toEqual([]);
  });

  it("allows only example-domain or public hostnames", () => {
    const allowed = [...EXAMPLE_DOMAINS, ...PUBLIC_HOSTS];
    const bad = findings((line) => {
      const withoutEmails = line.replace(EMAIL, "");
      const hosts = [
        ...[...withoutEmails.matchAll(URL_HOST)].map((m) => m[1] ?? ""),
        ...[...withoutEmails.matchAll(BARE_HOST)].map((m) => m[1] ?? ""),
      ];
      return hosts.filter((host) => host !== "" && !domainAllowed(host, allowed));
    });
    expect(bad).toEqual([]);
  });
});
