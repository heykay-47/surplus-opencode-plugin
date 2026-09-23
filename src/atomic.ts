import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"

export interface AtomicFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>
  stat(file: string): Promise<{ mode: number }>
  open(file: string, flags: "wx", mode: number): Promise<FileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(file: string): Promise<void>
}

export const atomicFileSystem: AtomicFileSystem = {
  mkdir: (directory, options) => fs.mkdir(directory, options),
  stat: (file) => fs.stat(file),
  open: (file, flags, mode) => fs.open(file, flags, mode),
  rename: (from, to) => fs.rename(from, to),
  unlink: (file) => fs.unlink(file),
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

export async function writeFileAtomically(
  file: string,
  content: string,
  fileSystem: AtomicFileSystem = atomicFileSystem,
): Promise<void> {
  const directory = path.dirname(file)
  await fileSystem.mkdir(directory, { recursive: true })

  let targetMode = 0o600
  try {
    targetMode = (await fileSystem.stat(file)).mode & 0o777
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  const temporary = path.join(directory, `.${path.basename(file)}.${randomBytes(16).toString("hex")}.tmp`)
  let handle: FileHandle | undefined
  let created = false
  try {
    handle = await fileSystem.open(temporary, "wx", 0o600)
    created = true
    await handle.chmod(0o600)
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await fileSystem.rename(temporary, file)
    created = false
    if (targetMode !== 0o600) await handle.chmod(targetMode)
    await handle.close()
    handle = undefined
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (handle) {
      try {
        await handle.close()
      } catch (closeError) {
        cleanupErrors.push(closeError)
      }
    }
    if (created) {
      try {
        await fileSystem.unlink(temporary)
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") cleanupErrors.push(unlinkError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Atomic file write failed and temporary-file cleanup was incomplete", { cause: error })
    }
    throw error
  }
}
