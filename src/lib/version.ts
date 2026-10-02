import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  name: string;
  version: string;
}

/** Name and version from package.json (two levels above both src/lib and dist/lib). */
export function packageInfo(): PackageInfo {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as Partial<PackageInfo>;
    return {
      name: typeof pkg.name === "string" ? pkg.name : "az-axi",
      version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    };
  } catch {
    return { name: "az-axi", version: "0.0.0" };
  }
}
