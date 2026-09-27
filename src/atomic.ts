import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import {
  assertWindowsDirectoriesProtected,
  copyWindowsFilePermissions,
  protectWindowsDirectory,
} from "./windows-security.js"

export interface AtomicFileSystem {
  mkdir(directory: string, options: { recursive?: boolean; mode: number }): Promise<unknown>
  realpath(file: string): Promise<string>
  stat(file: string): Promise<{ mode: number; uid: number }>
  open(file: string, flags: "wx", mode: number): Promise<FileHandle>
  protectDirectory(directory: string): Promise<void>
  copyPermissions(source: string, target: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(file: string): Promise<void>
  rmdir(directory: string): Promise<void>
}

export const atomicFileSystem: AtomicFileSystem = {
  mkdir: (directory, options) => fs.mkdir(directory, options),
  realpath: (file) => fs.realpath(file),
  stat: (file) => fs.stat(file),
  open: (file, flags, mode) => fs.open(file, flags, mode),
  protectDirectory: async (directory) => {
    if (process.platform === "win32") await protectWindowsDirectory(directory)
    else await fs.chmod(directory, 0o700)
  },
  copyPermissions: async (source, target, mode) => {
    if (process.platform === "win32") await copyWindowsFilePermissions(source, target)
    else await fs.chmod(target, mode)
  },
  rename: (from, to) => fs.rename(from, to),
  unlink: (file) => fs.unlink(file),
  rmdir: (directory) => fs.rmdir(directory),
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function isProtectedDirectory(directory: { mode: number; uid: number }): boolean {
  if (typeof process.getuid !== "function" || (directory.mode & 0o022) === 0) return true
  const hasStickyBit = (directory.mode & 0o1000) !== 0
  return hasStickyBit && (directory.uid === 0 || directory.uid === process.getuid())
}

async function assertProtectedPath(directory: string, fileSystem: AtomicFileSystem): Promise<void> {
  const paths = new Set<string>()
  const addAncestors = (start: string) => {
    let current = start
    while (true) {
      paths.add(current)
      const parent = path.dirname(current)
      if (parent === current) return
      current = parent
    }
  }

  addAncestors(path.resolve(directory))
  addAncestors(await fileSystem.realpath(directory))

  if (process.platform === "win32") {
    await assertWindowsDirectoriesProtected([...paths])
    return
  }

  for (const current of paths) {
    const info = await fileSystem.stat(current)
    if (!isProtectedDirectory(info)) {
      throw new Error("Refusing atomic write in a group- or world-writable directory without sticky protection")
    }
  }
}

export async function writeFileAtomically(
  file: string,
  content: string,
  fileSystem: AtomicFileSystem = atomicFileSystem,
): Promise<void> {
  const directory = path.dirname(file)
  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
  await assertProtectedPath(directory, fileSystem)

  let targetMode = 0o600
  let targetExists = false
  try {
    targetMode = (await fileSystem.stat(file)).mode & 0o777
    targetExists = true
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  const temporaryDirectory = path.join(directory, `.${path.basename(file)}.${randomBytes(16).toString("hex")}.tmp`)
  const temporary = path.join(temporaryDirectory, path.basename(file))
  let handle: FileHandle | undefined
  let temporaryDirectoryCreated = false
  let temporaryCreated = false
  try {
    await fileSystem.mkdir(temporaryDirectory, { recursive: false, mode: 0o700 })
    temporaryDirectoryCreated = true
    await fileSystem.protectDirectory(temporaryDirectory)

    const temporaryHandle = await fileSystem.open(temporary, "wx", 0o600)
    handle = temporaryHandle
    temporaryCreated = true
    await temporaryHandle.chmod(0o600)
    await temporaryHandle.writeFile(content, "utf8")
    await temporaryHandle.sync()

    if (targetExists) await fileSystem.copyPermissions(file, temporary, targetMode)
    await temporaryHandle.close()
    handle = undefined

    await fileSystem.rename(temporary, file)
    temporaryCreated = false
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (handle) {
      try {
        await handle.close()
      } catch (closeError) {
        cleanupErrors.push(closeError)
      }
    }
    if (temporaryCreated) {
      try {
        await fileSystem.unlink(temporary)
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") cleanupErrors.push(unlinkError)
      }
    }
    if (temporaryDirectoryCreated) {
      try {
        await fileSystem.rmdir(temporaryDirectory)
      } catch (rmdirError) {
        if (errorCode(rmdirError) !== "ENOENT") cleanupErrors.push(rmdirError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Atomic file write failed and temporary-file cleanup was incomplete", { cause: error })
    }
    throw error
  }

  try {
    await fileSystem.rmdir(temporaryDirectory)
  } catch {
    // The replacement is committed; a leftover empty private staging directory
    // must not make a successful save appear to have failed.
  }
}
