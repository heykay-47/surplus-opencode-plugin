import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const result = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { encoding: "utf8" }))
const pkg = Array.isArray(result) ? result[0] : result["opencode-surplus"]
assert.ok(pkg, "npm must return the package manifest")
const paths = new Set(pkg.files.map((file) => file.path))
for (const file of ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "source-lock.json", "tsconfig.json", "tsconfig.test.json", "dist/index.js", "dist/tui.js", "dist/cli.js"]) {
  assert.ok(paths.has(file), `Package is missing ${file}`)
}
for (const directory of ["src", "test", "scripts"]) {
  for (const file of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const parent = file.parentPath.replaceAll("\\", "/")
    const name = `${parent}/${file.name}`
    assert.ok(paths.has(name), `Package is missing source file ${name}`)
  }
}
for (const name of paths) {
  assert.ok(!/^(?:\.agent|docs|node_modules|\.git)(?:\/|$)|^(?:AGENTS|CONTEXT)\.md$|(?:^|\/)\.env(?:\.|$)/.test(name), `Private file included: ${name}`)
}
assert.equal(readFileSync("source-lock.json", "utf8"), readFileSync("package-lock.json", "utf8"))
assert.equal(JSON.parse(readFileSync("package.json", "utf8")).publishConfig.tag, "beta")
console.log(`Package contents verified: ${pkg.id}, ${paths.size} files, matching build source included.`)
