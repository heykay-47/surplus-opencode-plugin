import { execFile } from "node:child_process"
import path from "node:path"

const root = process.env.SystemRoot || process.env.WINDIR
const executable = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const minimal = {
  SystemRoot: root, WINDIR: root,
  PATH: `${path.join(root, "System32")};${root}`,
  PSModulePath: path.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  TEMP: path.join(root, "Temp"), TMP: path.join(root, "Temp"),
}
const script = Buffer.from("Write-Output '[DEBUG-PS-bb4e] started'; exit 0", "utf16le").toString("base64")
async function probe(label, env) {
  const started = Date.now()
  return new Promise(resolve => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script], { env, windowsHide: true, timeout: 5000 }, (error, stdout) => {
      console.log("[DEBUG-PS-bb4e]", JSON.stringify({label, duration: Date.now()-started, code:error?.code, timedOut:error?.killed ?? false, started:stdout.includes("[DEBUG-PS-bb4e] started")}))
      resolve()
    })
    child.stdin?.end()
  })
}
await probe("inherited", process.env)
await probe("minimal", minimal)
for (const name of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "COMSPEC", "USERNAME"]) {
  if (process.env[name]) await probe(`minimal plus ${name}`, {...minimal, [name]:process.env[name]})
}
