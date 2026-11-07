import { constants } from "node:fs"
import fs from "node:fs/promises"
import { assertOutputPath } from "../execute-realm/file-roots.ts"

export async function writeRecordingMetadata(outputPath: string, metadata: Record<string, unknown>, exclusive = false): Promise<void> {
  const sidecarPath = assertOutputPath(`${outputPath}.json`, "recording metadata")
  const sidecar = await fs.open(sidecarPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (exclusive ? constants.O_EXCL : 0), 0o600)
  try {
    const stat = await sidecar.stat()
    const current = await fs.lstat(sidecarPath)
    assertOutputPath(sidecarPath, "recording metadata")
    if (!stat.isFile() || stat.nlink !== 1 || current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev) {
      throw new Error("Recording metadata must be a regular file with one link and must not change while opening")
    }
    if (process.platform === "linux") assertOutputPath(await fs.realpath(`/proc/self/fd/${sidecar.fd}`), "recording metadata")
    await sidecar.truncate(0)
    await sidecar.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  } finally {
    await sidecar.close()
  }
}
