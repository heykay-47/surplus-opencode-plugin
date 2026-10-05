import { execFile } from "node:child_process"
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
  $dangerous = [int](
    [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
    [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $index = 0
  $safe = $true
  foreach ($directory in $paths) {
    $acl = Get-Acl -LiteralPath $directory
    $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
      $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
    )
    if ($null -eq $descriptor.DiscretionaryAcl) { [Console]::Error.WriteLine('[DEBUG-ACL-cc24] null DACL'); exit 1 }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($trusted -notcontains $owner) { [Console]::Error.WriteLine("[DEBUG-ACL-cc24] untrusted owner index $index"); exit 1 }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      if ($trusted -contains $rule.IdentityReference.Value) { continue }
      # Inherit-only rules do not grant access to this ancestor. At the
      # destination they may grant access to a newly created staging directory.
      if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -and $destinations -notcontains $directory) { continue }
      if (([int]$rule.FileSystemRights -band $dangerous) -ne 0) { [Console]::Error.WriteLine("[DEBUG-ACL-cc24] unsafe allow index $index rights $($rule.FileSystemRights) propagation $($rule.PropagationFlags)"); $safe = $false }
    }
    $index++
  }
  if (-not $safe) { exit 1 }
  exit 0
} catch {
  [Console]::Error.WriteLine("[DEBUG-ACL-cc24] exception type $($_.Exception.GetType().Name)")
  exit 1
}
`

const protectDirectoryScript = `
$ErrorActionPreference = 'Stop'
try {
  $directory = $env:OPENCODE_SURPLUS_ACL_DIRECTORY
  $acl = Get-Acl -LiteralPath $directory
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $principals = @(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  )
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
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
  Set-Acl -LiteralPath $directory -AclObject $acl | Out-Null
  exit 0
} catch {
  exit 1
}
`

const copyPermissionsScript = `
$ErrorActionPreference = 'Stop'
try {
  $acl = Get-Acl -LiteralPath $env:OPENCODE_SURPLUS_ACL_SOURCE
  Set-Acl -LiteralPath $env:OPENCODE_SURPLUS_ACL_TARGET -AclObject $acl | Out-Null
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
      (error, _stdout, stderr) => {
        if (!error) return resolve()
        const reason = error.killed ? "PowerShell timed out" : `PowerShell exit code ${error.code ?? "unknown"}`
        const diagnostic = stderr.match(/\[DEBUG-ACL-cc24\][^\r\n]*/)?.[0] ?? ""
        reject(new Error(`${failureMessage} (${reason}) ${diagnostic}`))
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
    protectDirectoryScript,
    { OPENCODE_SURPLUS_ACL_DIRECTORY: directory },
    "Unable to secure the temporary directory for an atomic write",
  )
}

export function copyWindowsFilePermissions(source: string, target: string): Promise<void> {
  return runPowerShell(
    copyPermissionsScript,
    { OPENCODE_SURPLUS_ACL_SOURCE: source, OPENCODE_SURPLUS_ACL_TARGET: target },
    "Unable to preserve the existing file permissions before replacement",
  )
}
