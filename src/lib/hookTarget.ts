import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AxiError } from "axi-sdk-js";

/** Hooks outlive validation builds, so only durable installations may be registered. */
export function assertDurableHookTarget(entry: string): void {
  const absolute = resolve(entry);
  const paths = [absolute, realpathSync(absolute)];
  const temporaryRoots = [tmpdir(), "/tmp", "/var/tmp", "/private/tmp"].map((path) => resolve(path));
  for (const path of paths) {
    const temporary = temporaryRoots.some((root) => {
      const child = relative(root, path);
      return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
    });
    const disposable = path.split(sep).some((part) => [
      ".treehouse", ".worktrees", "worktrees", ".no-mistakes", "no-mistakes", "pipeline-builds",
    ].includes(part));
    let worktree = false;
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const git = join(dir, ".git");
      if (existsSync(git) && statSync(git).isFile()) worktree = true;
      if (dirname(dir) === dir) break;
    }
    if (temporary || disposable || worktree) {
      throw new AxiError("cannot install session hooks from a temporary directory, worktree or pipeline build", "VALIDATION_ERROR", [
        "Install @knowttl/az-axi in a persistent location, then run `az-axi setup hooks` from that installation",
      ]);
    }
  }
}
