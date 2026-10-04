// Public-repo guard (plan Section 7.3). This repository is public: no real tenant,
// subscription, workspace, object or application IDs, and no real domains or hostnames.
// Scans every tracked text file (plus new files not yet ignored by git).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTOR_ROLE_ID,
  OWNER_ROLE_ID,
  RBAC_ADMIN_ROLE_ID,
  USER_ACCESS_ADMIN_ROLE_ID,
} from "../src/lib/roles.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Synthetic identifiers: 00000000-0000-0000-0000-0000000000NN
const SYNTHETIC_GUID = /^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$/;

// Public, Microsoft-wide GUIDs that are required for function and are not tenant data.
// Built-in role definition IDs live in src/lib/roles.ts and are allowed by import,
// so the only literal listed here is the legacy Azure DevOps constant quoted in PLAN.md.
const PUBLIC_GUIDS: readonly string[] = [
  // Azure DevOps resource ID, a public Microsoft constant. It no longer appears in src/lib/auth.ts
  // (generalized in Phase 1) but PLAN.md still quotes it, so it stays allowed.
  "499b84ac-1321-427f-aa17-267ca6975798",
  OWNER_ROLE_ID.toLowerCase(),
  CONTRIBUTOR_ROLE_ID.toLowerCase(),
  USER_ACCESS_ADMIN_ROLE_ID.toLowerCase(),
  RBAC_ADMIN_ROLE_ID.toLowerCase(),
];

// Documentation domains for synthetic examples (any subdomain is allowed).
const EXAMPLE_DOMAINS: readonly string[] = ["contoso.com", "fabrikam.com", "example.com", "stexample.blob.core.windows.net"];

// Public hosts that docs, API endpoints, tooling and links legitimately name (any subdomain is allowed).
const PUBLIC_HOSTS: readonly string[] = [
  "azure.com",
  "vault.azure.net",
  "claude.com",
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
// Hostnames: any URL host, plus bare names under TLDs that real tenants use.
// Common code words (".org", ".io", ".dev") and file names (".md", ".js") are only checked as URL hosts.
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/gi;
const BARE_HOST =
  /(?<![A-Za-z0-9@./_-])((?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|cloud|local|corp|internal|intranet|lan))(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/gi;

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

export function scanIdentifiers(files: readonly { path: string; lines: readonly string[] }[]): string[] {
  const found: string[] = [];
  const allowed = [...EXAMPLE_DOMAINS, ...PUBLIC_HOSTS];
  for (const { path, lines } of files) {
    lines.forEach((line, index) => {
      const guids = [...line.matchAll(GUID)]
        .map((m) => m[0])
        .filter((guid) => !SYNTHETIC_GUID.test(guid.toLowerCase()) && !PUBLIC_GUIDS.includes(guid.toLowerCase()));
      const emails = [...line.matchAll(EMAIL)]
        .filter((m) => !domainAllowed(m[1] ?? "", EXAMPLE_DOMAINS))
        .map((m) => m[0]);
      const withoutEmails = line.replace(EMAIL, "");
      const hosts = [
        ...[...withoutEmails.matchAll(URL_HOST)].map((m) => m[1] ?? ""),
        ...[...withoutEmails.matchAll(BARE_HOST)].map((m) => m[1] ?? ""),
      ].filter((host) => host !== "" && !domainAllowed(host, allowed));
      for (const token of [...guids, ...emails, ...hosts]) {
        found.push(`${path}:${index + 1}: ${token}`);
      }
    });
  }
  return found;
}

describe("public-repo identifier guard", () => {
  it("audits repository text files for prohibited identifiers", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(scanIdentifiers(files)).toEqual([]);
  });

  it("accepts synthetic GUIDs, public GUIDs, example emails and public hosts", () => {
    expect(scanIdentifiers([{
      path: "allowed.txt",
      lines: [
        "00000000-0000-0000-0000-000000000001 00000000-0000-0000-0000-0000000000AF",
        ...PUBLIC_GUIDS.map((guid) => guid.toUpperCase()),
        "analyst@CONTOSO.COM analyst@team.fabrikam.com analyst@example.com",
        "contoso.com service.example.com https://code.claude.com/docs https://MANAGEMENT.AZURE.COM/",
        EXAMPLE_DOMAINS[0].toUpperCase(),
        `HTTPS://${PUBLIC_HOSTS[0].toUpperCase()}/`,
      ],
    }])).toEqual([]);
  });

  it("reports prohibited GUIDs with their file and line", () => {
    const guid = ["3f2a9c1e", "7b4d", "4e86", "9a15", "c0d2e8f6b7a4"].join("-");
    expect(scanIdentifiers([
      { path: "first.txt", lines: ["allowed", guid] },
      { path: "second.txt", lines: [guid.toUpperCase()] },
    ])).toEqual([`first.txt:2: ${guid}`, `second.txt:1: ${guid.toUpperCase()}`]);
  });

  it("reports prohibited emails, including emails at public hosts", () => {
    const domain = ["corp-example", "net"].join(".");
    const email = `analyst@${domain}`;
    const publicEmail = ["analyst", "microsoft.com"].join("@");
    expect(scanIdentifiers([{ path: "emails.txt", lines: [email, publicEmail] }]))
      .toEqual([`emails.txt:1: ${email}`, `emails.txt:2: ${publicEmail}`]);
  });

  it("reports prohibited URL and bare hosts without accepting lookalike domains", () => {
    const domain = ["corp-example", "net"].join(".");
    const lookalike = `contoso.com.${domain}`;
    const prefix = `not${EXAMPLE_DOMAINS[0]}`;
    expect(scanIdentifiers([{
      path: "hosts.txt",
      lines: [`https://${domain}/path`, domain, `https://${lookalike}/`, prefix],
    }])).toEqual([
      `hosts.txt:1: ${domain}`,
      `hosts.txt:2: ${domain}`,
      `hosts.txt:3: ${lookalike}`,
      `hosts.txt:4: ${prefix}`,
    ]);
  });

  it("reports uppercase and mixed-case prohibited hosts", () => {
    const domain = ["corp-example", "net"].join(".");
    const upper = domain.toUpperCase();
    const mixed = domain
      .split("-")
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join("-");
    expect(scanIdentifiers([{
      path: "hosts.txt",
      lines: [upper, mixed, `https://${upper}/`.toUpperCase(), `Https://${mixed}/`],
    }])).toEqual([
      `hosts.txt:1: ${upper}`,
      `hosts.txt:2: ${mixed}`,
      `hosts.txt:3: ${upper}`,
      `hosts.txt:4: ${mixed}`,
    ]);
  });
});
