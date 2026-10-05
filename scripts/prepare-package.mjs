import { chmod, copyFile } from "node:fs/promises"

// npm excludes package-lock.json from tarballs. Ship the same build lock under
// a different name so recipients can reproduce this release's source build.
await copyFile("package-lock.json", "source-lock.json")
await chmod("dist/cli.js", 0o755)
