import { constants } from "node:fs"
import fs from "node:fs/promises"
import { assertOutputPath } from "../execute-realm/file-roots.ts"

export async function writeRecordingMetadata(outputPath: string, metadata: Record<string, unknown>, exclusive = false): Promise<void> {
  const sidecarPath = assertOutputPath(`${outputPath}.json`, "recording metadata")
  const sidecar = await fs.open(sidecarPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (exclusive ? constants.O_EXCL : constants.O_TRUNC), 0o600)
  try {
    await sidecar.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  } finally {
    await sidecar.close()
  }
}
