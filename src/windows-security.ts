import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"

const checkDirectoriesScript = `
$ErrorActionPreference = 'Stop'
try {
  $paths = ConvertFrom-Json -InputObject $env:OPENCODE_SURPLUS_ACL_PATHS
  $destinations = ConvertFrom-Json -InputObject $env:OPENCODE_SURPLUS_ACL_DESTINATIONS
  $trusted = @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    'S-1-5-18',
    'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
    'S-1-3-0',
    'S-1-3-4'
  )
  $ancestorDangerous = [int](
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor
    0x10000000
  )
  $destinationDangerous = [int](
    $ancestorDangerous -bor
    [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
    [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor
    0x40000000
  )
  foreach ($directory in $paths) {
    $acl = Get-Acl -LiteralPath $directory
    $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
      $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
    )
    if ($null -eq $descriptor.DiscretionaryAcl) { exit 1 }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($trusted -notcontains $owner) { exit 1 }
    $isDestination = $destinations -contains $directory
    # Creating siblings cannot replace an existing protected ancestor. Creating
    # children at the destination can race creation of our staging directory.
    $dangerous = if ($isDestination) { $destinationDangerous } else { $ancestorDangerous }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      if ($trusted -contains $rule.IdentityReference.Value) { continue }
      # Inherit-only rules do not grant access to this ancestor. At the
      # destination they may grant access to a newly created staging directory.
      if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -and -not $isDestination) { continue }
      # Generic ALL/WRITE bits can remain unmapped on inherit-only ACEs.
      if (([int]$rule.FileSystemRights -band $dangerous) -ne 0) { exit 1 }
    }
  }
  exit 0
} catch {
  exit 1
}
`

const protectPathScript = `
$ErrorActionPreference = 'Stop'
try {
  $target = $env:OPENCODE_SURPLUS_ACL_DIRECTORY
  $isFile = $env:OPENCODE_SURPLUS_ACL_FILE -eq 'true'
  $acl = if ($isFile) { [System.Security.AccessControl.FileSecurity]::new() } else { [System.Security.AccessControl.DirectorySecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  $principals = @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  )
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $inheritance = if ($isFile) { [System.Security.AccessControl.InheritanceFlags]::None } else { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
  foreach ($principal in $principals) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $principal,
      $rights,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  if ($isFile) { [System.IO.File]::SetAccessControl($target, $acl) } else { [System.IO.Directory]::SetAccessControl($target, $acl) }
  exit 0
} catch {
  exit 1
}
`

const copyPermissionsScript = `
$ErrorActionPreference = 'Stop'
try {
  # Read the stored descriptor directly; higher-level access-control objects
  # can normalize legacy descriptors to the automatic inheritance model.
  Add-Type -TypeDefinition @'
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SurplusFileSecurity {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileSecurityW(string path, uint information, [Out] byte[] descriptor, uint length, out uint needed);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetFileSecurityW(string path, uint information, byte[] descriptor);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint SetNamedSecurityInfoW(string path, int type, uint information, System.IntPtr owner, System.IntPtr group, System.IntPtr dacl, System.IntPtr sacl);
  public static byte[] Read(string path) {
    const uint ownerAndDacl = 5;
    uint needed;
    GetFileSecurityW(path, ownerAndDacl, null, 0, out needed);
    if (needed == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    var descriptor = new byte[checked((int)needed)];
    if (!GetFileSecurityW(path, ownerAndDacl, descriptor, needed, out needed))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return descriptor;
  }
  public static void WriteDacl(string path, byte[] acl, bool protect) {
    var pointer = acl == null ? System.IntPtr.Zero : Marshal.AllocHGlobal(acl.Length);
    try {
      if (acl != null) Marshal.Copy(acl, 0, pointer, acl.Length);
      const int fileObject = 1;
      const uint daclInformation = 4;
      uint protection = protect ? 0x80000000u : 0x20000000u;
      uint error = SetNamedSecurityInfoW(path, fileObject, daclInformation | protection, System.IntPtr.Zero, System.IntPtr.Zero, pointer, System.IntPtr.Zero);
      if (error != 0) throw new Win32Exception((int)error);
    } finally {
      if (pointer != System.IntPtr.Zero) Marshal.FreeHGlobal(pointer);
    }
  }
}
'@
  $descriptor = [SurplusFileSecurity]::Read($env:OPENCODE_SURPLUS_ACL_SOURCE)
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($descriptor, 0)
  $target = [System.Security.AccessControl.RawSecurityDescriptor]::new([SurplusFileSecurity]::Read($env:OPENCODE_SURPLUS_ACL_TARGET), 0)
  if ($raw.Owner.Value -ne $target.Owner.Value) { exit 2 }
  $access = [System.Security.AccessControl.AccessControlSections]::Access
  $modern = [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected -bor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
  if (($raw.ControlFlags -band $modern) -ne 0) {
    # Preserve ACE ordering instead of normalizing through FileSecurity.
    # The named destination link shares the original parent for inheritance.
    $bytes = $null
    if ($null -ne $raw.DiscretionaryAcl) {
      $bytes = [byte[]]::new($raw.DiscretionaryAcl.BinaryLength)
      $raw.DiscretionaryAcl.GetBinaryForm($bytes, 0)
    }
    $protect = ($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
    [SurplusFileSecurity]::WriteDacl($env:OPENCODE_SURPLUS_ACL_TARGET, $bytes, $protect)
  } else {
    # Legacy DACLs must not be converted to automatic inheritance.
    $daclSecurityInformation = 4
    if (-not [SurplusFileSecurity]::SetFileSecurityW($env:OPENCODE_SURPLUS_ACL_TARGET, $daclSecurityInformation, $descriptor)) { exit 1 }
  }
  $copied = [System.Security.AccessControl.RawSecurityDescriptor]::new([SurplusFileSecurity]::Read($env:OPENCODE_SURPLUS_ACL_TARGET), 0)
  if ($raw.Owner.Value -ne $copied.Owner.Value -or $raw.GetSddlForm($access) -ne $copied.GetSddlForm($access)) { exit 1 }
  exit 0
} catch {
  exit 1
}
`

function runPowerShell(script: string, variables: Record<string, string>, failureMessage: string): Promise<void> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (!systemRoot) return Promise.reject(new Error(failureMessage))

  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const temp = path.join(systemRoot, "Temp")
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
    PSModulePath: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    TEMP: temp,
    TMP: temp,
    ...variables,
  }
  const encodedScript = Buffer.from(script, "utf16le").toString("base64")

  return new Promise((resolve, reject) => {
    const child = execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      { env, windowsHide: true, timeout: 60_000, maxBuffer: 4096, encoding: "utf8" },
      (error) => {
        if (!error) return resolve()
        const reason = error.killed ? "PowerShell timed out" : `PowerShell exit code ${error.code ?? "unknown"}`
        reject(new Error(`${failureMessage} (${reason})`))
      },
    )
    // Input is carried in the environment; close the unused stdin pipe.
    child.stdin?.end()
  })
}

export function assertWindowsDirectoriesProtected(directories: string[], destinations: string[] = directories): Promise<void> {
  return runPowerShell(
    checkDirectoriesScript,
    {
      OPENCODE_SURPLUS_ACL_PATHS: JSON.stringify(directories),
      OPENCODE_SURPLUS_ACL_DESTINATIONS: JSON.stringify(destinations),
    },
    "Refusing atomic write because Windows directory permissions are unsafe or could not be verified",
  )
}

export function protectWindowsDirectory(directory: string): Promise<void> {
  return runPowerShell(
    protectPathScript,
    { OPENCODE_SURPLUS_ACL_DIRECTORY: directory },
    "Unable to secure the temporary directory for an atomic write",
  )
}

export async function copyWindowsFilePermissions(source: string, target: string): Promise<void> {
  const link = path.join(path.dirname(source), `${path.basename(path.dirname(target))}.acl`)
  await fs.link(target, link)
  try {
    await runPowerShell(
      copyPermissionsScript,
      {
        OPENCODE_SURPLUS_ACL_SOURCE: source,
        OPENCODE_SURPLUS_ACL_TARGET: link,
        TEMP: path.dirname(target),
        TMP: path.dirname(target),
      },
      "Unable to preserve the existing file ownership and permissions before replacement",
    )
  } catch (error) {
    try {
      await fs.unlink(link)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Windows permission preparation failed and link cleanup was incomplete", { cause: error })
    }
    throw error
  }
  await fs.unlink(link)
}

export async function renameWindowsFile(source: string, target: string): Promise<void> {
  try {
    await fs.stat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // New files must stay private even if the destination parent later grants
    // inheritable read access to other users.
    await runPowerShell(
      protectPathScript,
      { OPENCODE_SURPLUS_ACL_DIRECTORY: source, OPENCODE_SURPLUS_ACL_FILE: "true" },
      "Unable to secure the new file before replacement",
    )
  }
  // Moving out of the staging directory can recalculate inherited ACEs.
  // A hard link retains the prepared security descriptor; rename within the
  // destination directory then replaces the config without crossing parents.
  const link = path.join(path.dirname(target), `${path.basename(path.dirname(source))}.link`)
  await fs.link(source, link)
  try {
    await fs.unlink(source)
    await fs.rename(link, target)
  } catch (error) {
    try {
      await fs.unlink(link)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "Windows atomic replacement failed and link cleanup was incomplete", { cause: error })
      }
    }
    throw error
  }
}
