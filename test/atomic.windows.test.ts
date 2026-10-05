import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { writeFileAtomically } from "../src/atomic.js"
import { assertWindowsDirectoriesProtected } from "../src/windows-security.js"

function runIcacls(args: string[]): Promise<string> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows"
  const icacls = path.join(systemRoot, "System32", "icacls.exe")
  return new Promise((resolve, reject) => {
    execFile(icacls, args, { windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

test("Windows ACL inspection completes without stdin input", {
  skip: process.platform !== "win32",
}, async () => {
  await assertWindowsDirectoriesProtected([])
})

test("Windows inherit-only permissions are ignored on ancestors but rejected on staging parents", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-windows-inheritance-"))
  const child = path.join(root, "private")
  try {
    await mkdir(child)
    // Freeze the child's existing private ACL before adding an inheritable
    // rule to its parent. The new rule does not grant access to the parent.
    await runIcacls([child, "/inheritance:d"])
    await runIcacls([root, "/grant", "*S-1-5-32-545:(OI)(CI)(IO)(F)"])
    await assertWindowsDirectoriesProtected([root, child], [child])
    await assert.rejects(
      assertWindowsDirectoriesProtected([root]),
      /Windows directory permissions are unsafe or could not be verified/,
    )
  } finally {
    await runIcacls([root, "/remove:g", "*S-1-5-32-545"])
    await rm(root, { recursive: true, force: true })
  }
})

test("Windows atomic writes preserve file ACLs and refuse shared-writable directories", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-windows-acl-"))
  const config = path.join(root, "opencode.json")
  const shared = path.join(root, "shared")
  try {
    await writeFile(config, "original")
    const originalAcl = await runIcacls([config])
    await writeFileAtomically(config, "replacement")
    assert.equal(await readFile(config, "utf8"), "replacement")
    assert.equal(await runIcacls([config]), originalAcl)

    await mkdir(shared)
    await runIcacls([shared, "/grant", "*S-1-5-32-545:(OI)(CI)(M)"])
    try {
      await assert.rejects(
        writeFileAtomically(path.join(shared, "opencode.json"), "must not be written"),
        /Windows directory permissions are unsafe or could not be verified/,
      )
    } finally {
      await runIcacls([shared, "/remove:g", "*S-1-5-32-545"])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
