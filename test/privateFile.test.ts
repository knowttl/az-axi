import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readPrivateFile, toolDirectory, writePrivateFile } from "../src/lib/privateFile.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "az-axi-private-"));
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(renameSync).mockImplementation(fs.renameSync);
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(renameSync).mockReset(); rmSync(dir, { recursive: true, force: true }); });

it("uses only absolute XDG paths on Unix and ignores XDG on Windows", () => {
  expect(toolDirectory("config", { XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/test")).toBe("/xdg/az-axi");
  expect(toolDirectory("state", { XDG_STATE_HOME: "relative" }, "linux", "/home/test")).toBe("/home/test/.local/state/az-axi");
  expect(toolDirectory("config", { XDG_CONFIG_HOME: "/ignored", APPDATA: "/roaming" }, "win32", "/home/test")).toBe("/roaming/az-axi");
  expect(toolDirectory("state", { XDG_STATE_HOME: "/ignored", LOCALAPPDATA: "/local" }, "win32", "/home/test")).toBe("/local/az-axi");
});

it.skipIf(process.platform === "win32")("rejects writable configs, public secrets and symlinks before reading", () => {
  const path = join(dir, "private");
  writeFileSync(path, "sensitive", { mode: 0o666 });
  chmodSync(path, 0o666);
  expect(() => readPrivateFile(path)).toThrowError(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  chmodSync(path, 0o644);
  expect(readPrivateFile(path)).toBe("sensitive");
  expect(() => readPrivateFile(path, true)).toThrowError(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  chmodSync(path, 0o400);
  expect(readPrivateFile(path, true)).toBe("sensitive");
  const link = join(dir, "link");
  symlinkSync(path, link);
  expect(() => readPrivateFile(link)).toThrowError(expect.objectContaining({ code: "CONFIG_INSECURE" }));
  expect(() => readPrivateFile(dir)).toThrowError(expect.objectContaining({ code: "CONFIG_INSECURE" }));
});

it("keeps the old file and removes the temp file when a write fails", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, "old");
  const acl = vi.fn((_path, action) => { if (action === "protect" && _path !== dir) throw new Error("ACL denied"); });
  expect(() => writePrivateFile(path, "new", { platform: "win32", acl })).toThrow("ACL denied");
  expect(readFileSync(path, "utf8")).toBe("old");
  expect(readdirSync(dir)).toEqual(["config.json"]);
});

it.skipIf(process.platform === "win32")("replaces configs with private files and hardens existing directories", () => {
  const path = join(dir, "config.json");
  chmodSync(dir, 0o755);
  writeFileSync(path, "old"); chmodSync(path, 0o644);
  writePrivateFile(path, "new");
  expect(readPrivateFile(path)).toBe("new");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(readdirSync(dir)).toEqual(["config.json"]);
});

it.skipIf(process.platform === "win32")("rejects a config owned by a different uid", () => {
  const path = join(dir, "config.json");
  writeFileSync(path, "private", { mode: 0o600 });
  vi.spyOn(process, "getuid").mockReturnValue(statSync(path).uid + 1);
  expect(() => readPrivateFile(path)).toThrowError(expect.objectContaining({ code: "CONFIG_INSECURE" }));
});

it("applies Windows ACLs before content is written and verifies only on diagnostics", () => {
  const path = join(dir, "config.json");
  const acl = vi.fn((target, action, directory) => {
    if (action === "protect" && !directory) expect(readFileSync(target, "utf8")).toBe("");
  });
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    writeFileSync(to, readFileSync(from));
    rmSync(from);
  });
  writePrivateFile(path, "private", { platform: "win32", acl });
  expect(acl).toHaveBeenCalledWith(dir, "protect", true);
  if (process.platform !== "win32") chmodSync(path, 0o666);
  expect(readPrivateFile(path, true, false, { platform: "win32", acl })).toBe("private");
  expect(acl).toHaveBeenLastCalledWith(path, "check", false);
  expect(readPrivateFile(path, true, true, { platform: "win32", acl })).toBe("private");
  expect(acl).toHaveBeenLastCalledWith(path, "verify", false);
});

it.each(["EPERM", "EBUSY", "EACCES"])("retries transient Windows rename error %s", (code) => {
  const path = join(dir, "config.json");
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error("busy"), { code }); })
    .mockImplementationOnce((from, to) => { writeFileSync(to, readFileSync(from)); rmSync(from); });
  writePrivateFile(path, "new", { platform: "win32", acl: () => {} });
  expect(readFileSync(path, "utf8")).toBe("new");
  expect(wait).toHaveBeenCalledOnce();
});

it("bounds Windows rename retries and cleans up after timeout", () => {
  const path = join(dir, "config.json");
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1001);
  vi.mocked(renameSync).mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EPERM" }); });
  expect(() => writePrivateFile(path, "new", { platform: "win32", acl: () => {} })).toThrow("busy");
  expect(readdirSync(dir)).toEqual([]);
});
