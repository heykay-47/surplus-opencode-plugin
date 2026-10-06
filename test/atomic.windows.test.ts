import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { writeFileAtomically } from "../src/atomic.js"
import { assertWindowsDirectoriesProtected, renameWindowsFile } from "../src/windows-security.js"

function runWindowsTool(name: string, args: string[]): Promise<string> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows"
  const executable = path.join(systemRoot, "System32", name)
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function runIcacls(args: string[]): Promise<string> {
  return runWindowsTool("icacls.exe", args)
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

test("Windows allows create-only ancestors but rejects destructive ancestors and writable staging parents", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-windows-ancestor-"))
  const child = path.join(root, "private")
  try {
    await mkdir(child)
    await runIcacls([child, "/inheritance:d"])
    await runIcacls([root, "/grant", "*S-1-5-32-545:(WD,AD)"])
    await assertWindowsDirectoriesProtected([root, child], [child])
    await assert.rejects(
      assertWindowsDirectoriesProtected([root]),
      /Windows directory permissions are unsafe or could not be verified/,
    )

    await runIcacls([root, "/grant:r", "*S-1-5-32-545:(DC)"])
    await assert.rejects(
      assertWindowsDirectoriesProtected([root, child], [child]),
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

    // Cover both protected explicit rules and an inheritance-enabled DACL.
    await runIcacls([config, "/inheritance:d"])
    const protectedAcl = await runIcacls([config])
    await writeFileAtomically(config, "protected replacement")
    assert.equal(await readFile(config, "utf8"), "protected replacement")
    assert.equal(await runIcacls([config]), protectedAcl)
    await runIcacls([config, "/inheritance:e"])
    const inheritedAcl = await runIcacls([config])
    await writeFileAtomically(config, "inherited replacement")
    assert.equal(await readFile(config, "utf8"), "inherited replacement")
    assert.equal(await runIcacls([config]), inheritedAcl)
    assert.deepEqual(await readdir(root), ["opencode.json"])

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

test("Windows failed linked replacement cleans its alias and leaves the target intact", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-windows-link-"))
  const staged = path.join(root, "staged.json")
  const occupied = path.join(root, "occupied")
  try {
    await writeFile(staged, "replacement")
    await mkdir(occupied)
    await writeFile(path.join(occupied, "original.json"), "original")
    await assert.rejects(renameWindowsFile(staged, occupied))
    assert.equal(await readFile(path.join(occupied, "original.json"), "utf8"), "original")
    assert.deepEqual(await readdir(root), ["occupied"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Windows preserves explicit default ACL entries under a non-inheriting parent", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-windows-explicit-"))
  const config = path.join(root, "opencode.json")
  try {
    const identity = await runWindowsTool("whoami.exe", ["/user", "/fo", "csv", "/nh"])
    const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0]
    assert.ok(sid)
    await runIcacls([root, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"])
    await writeFile(config, "original")
    const originalAcl = await runIcacls([config])
    assert.equal(originalAcl.includes("(I)"), false)
    await writeFileAtomically(config, "replacement")
    assert.equal(await readFile(config, "utf8"), "replacement")
    assert.equal(await runIcacls([config]), originalAcl)
    assert.deepEqual(await readdir(root), ["opencode.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Windows new configs have private explicit ACLs even under a readable parent", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-windows-private-"))
  const config = path.join(root, "opencode.json")
  try {
    await runIcacls([root, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"])
    await writeFileAtomically(config, "new config")
    assert.equal(await readFile(config, "utf8"), "new config")
    assert.equal((await runIcacls([config])).includes("(I)"), false)
    assert.equal((await runIcacls([config, "/findsid", "*S-1-5-32-545"])).includes(config), false)
    await runIcacls([root, "/grant", "*S-1-5-11:(OI)(CI)(RX)"])
    assert.equal((await runIcacls([config, "/findsid", "*S-1-5-11"])).includes(config), false)
    assert.deepEqual(await readdir(root), ["opencode.json"])
  } finally {
    await runIcacls([root, "/remove:g", "*S-1-5-32-545"])
    await runIcacls([root, "/remove:g", "*S-1-5-11"])
    await rm(root, { recursive: true, force: true })
  }
})

test("Windows rejects replacement when the original file has a different owner", {
  skip: process.platform !== "win32",
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-windows-owner-"))
  const config = path.join(root, "opencode.json")
  try {
    await writeFile(config, "original")
    try {
      await runIcacls([config, "/setowner", "*S-1-5-19"])
    } catch (error) {
      if (process.env.GITHUB_ACTIONS === "true") throw error
      context.skip("Requires privileges to assign a different file owner")
      return
    }
    await assert.rejects(writeFileAtomically(config, "replacement"), /PowerShell exit code 2/)
    assert.equal(await readFile(config, "utf8"), "original")
    assert.deepEqual(await readdir(root), ["opencode.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
