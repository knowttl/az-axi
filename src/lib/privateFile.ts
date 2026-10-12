import { constants, closeSync, chmodSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { AxiError } from "axi-sdk-js";
import type { Stats } from "node:fs";

type AclAction = "protect" | "verify" | "check";
export interface PrivateFileOptions {
  platform?: NodeJS.Platform;
  acl?: (path: string, action: AclAction, directory: boolean) => void;
}

function insecure(path: string, platform: NodeJS.Platform): AxiError {
  return new AxiError(`private file is insecure: ${path}`, "CONFIG_INSECURE", [
    platform === "win32" ? `Re-run the tool's write for ${path} to restore its protected DACL` : `chmod 600 '${path.replaceAll("'", "'\\''")}'`,
  ]);
}

/** All paths enter PowerShell as environment data, never executable source. */
function windowsAcl(path: string, action: AclAction, directory: boolean): void {
  const script = `
$ErrorActionPreference = 'Stop'
$path = $env:AZ_AXI_PRIVATE_PATH
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
if ($env:AZ_AXI_PRIVATE_ACTION -eq 'check') { exit 0 }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$ids = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($env:AZ_AXI_PRIVATE_ACTION -eq 'protect') {
  if ($env:AZ_AXI_PRIVATE_DIRECTORY -eq 'true') {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($user)
  foreach ($id in $ids) {
    $sid = [Security.Principal.SecurityIdentifier]::new($id)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
} else {
  $acl = Get-Acl -LiteralPath $path
  if (-not $acl.AreAccessRulesProtected) { throw 'Inherited DACL' }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Unexpected owner' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.IdentityReference.Value -notin $ids -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected access rule' }
  }
  foreach ($id in $ids) {
    if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $id })) { throw 'Missing access rule' }
  }
}
`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, AZ_AXI_PRIVATE_PATH: path, AZ_AXI_PRIVATE_ACTION: action, AZ_AXI_PRIVATE_DIRECTORY: String(directory) },
    stdio: "ignore", timeout: 10_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw insecure(path, "win32");
}

export function toolDirectory(kind: "config" | "state", env = process.env, platform = process.platform, home = homedir()): string {
  if (platform === "win32") {
    const base = kind === "config" ? env.APPDATA ?? join(home, "AppData", "Roaming") : env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(base, "az-axi");
  }
  const override = kind === "config" ? env.XDG_CONFIG_HOME : env.XDG_STATE_HOME;
  const base = override && isAbsolute(override) ? override : kind === "config" ? join(home, ".config") : join(home, ".local", "state");
  return join(base, "az-axi");
}

export function ensurePrivateDirectory(path: string, options: PrivateFileOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (!existsSync(path)) {
    const parent = dirname(path);
    if (!existsSync(parent)) ensurePrivateDirectory(parent, options);
    mkdirSync(path, { mode: platform === "win32" ? undefined : 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (platform !== "win32" && stat.uid !== process.getuid?.())) throw insecure(path, platform);
  if (platform === "win32") (options.acl ?? windowsAcl)(path, "protect", true);
  else chmodSync(path, 0o700);
}

/** Check metadata before opening, then check the open descriptor before reading. */
export function readPrivateFile(path: string, secret = false, verifyAcl = false, options: PrivateFileOptions = {}): string {
  const platform = options.platform ?? process.platform;
  let stat: Stats;
  try { stat = lstatSync(path); }
  catch { throw insecure(path, platform); }
  const valid = (metadata: typeof stat) => metadata.isFile() && (platform === "win32" ||
    (metadata.uid === process.getuid?.() && (metadata.mode & (secret ? 0o077 : 0o022)) === 0));
  if (stat.isSymbolicLink() || !valid(stat)) throw insecure(path, platform);
  if (platform === "win32") (options.acl ?? windowsAcl)(path, verifyAcl ? "verify" : "check", false);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch { throw insecure(path, platform); }
  try {
    const opened = fstatSync(fd);
    if (!valid(opened) || opened.ino !== stat.ino || opened.dev !== stat.dev) throw insecure(path, platform);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export function writePrivateFile(path: string, content: string, options: PrivateFileOptions = {}): void {
  const platform = options.platform ?? process.platform;
  ensurePrivateDirectory(dirname(path), options);
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw insecure(path, platform);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", platform === "win32" ? undefined : 0o600);
    if (platform === "win32") (options.acl ?? windowsAcl)(temporary, "protect", false);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const deadline = Date.now() + 1000;
    let delay = 10;
    for (;;) {
      try { renameSync(temporary, path); break; }
      catch (error) {
        if (platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, deadline - Date.now()));
        delay = Math.min(delay * 2, 100);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Journals use a single O_APPEND write so concurrent invocations cannot lose entries. */
export function appendPrivateFile(path: string, content: string, options: PrivateFileOptions = {}): void {
  const platform = options.platform ?? process.platform;
  ensurePrivateDirectory(dirname(path), options);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw insecure(path, platform);
    if (platform === "win32") (options.acl ?? windowsAcl)(path, "check", false);
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (platform === "win32" ? 0 : constants.O_NOFOLLOW), platform === "win32" ? undefined : 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw insecure(path, platform);
    if (platform === "win32") (options.acl ?? windowsAcl)(path, "protect", false);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
