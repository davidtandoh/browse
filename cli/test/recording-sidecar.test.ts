import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { RecordingRelay } from "../src/recording-relay.ts"

test.each(["new", "existing", "outside symlink", "inside symlink", "dangling symlink"])("CDP recording metadata: %s", async (kind) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".recording-sidecar-"))
  const previousOutput = process.env.OPENCODE_BROWSER_OUTPUT_DIR
  const output = path.join(root, "output")
  fs.mkdirSync(output, { mode: 0o700 })
  process.env.OPENCODE_BROWSER_OUTPUT_DIR = output
  const outputPath = path.join(output, "demo.webm")
  const sidecarPath = `${outputPath}.json`
  const target = path.join(kind === "inside symlink" ? output : root, "target.json")
  const relay = new RecordingRelay({
    isExtensionConnected: () => true,
    sendToExtension: async () => ({}),
    sendDebuggerCommand: async ({ method }) => method === "Page.captureScreenshot" ? { data: Buffer.from("frame").toString("base64") } : {},
    startVideoEncoder: async () => ({
      write: async () => {},
      finish: async () => { fs.writeFileSync(outputPath, "video") },
      cancel: async () => {},
    }),
  })
  try {
    expect((await relay.startRecording({ tabId: 1, owner: "relay", mode: "cdp", outputPath })).success).toBe(true)
    if (kind === "existing") fs.writeFileSync(sidecarPath, "old metadata".repeat(1000))
    if (kind.endsWith("symlink")) {
      if (kind !== "dangling symlink") fs.writeFileSync(target, "unchanged")
      fs.symlinkSync(target, sidecarPath)
    }
    const result = await relay.stopRecording({ tabId: 1 })
    expect(relay.hasActiveRecordings()).toBe(false)
    if (kind.endsWith("symlink")) {
      expect(result.success).toBe(false)
      expect(fs.lstatSync(sidecarPath).isSymbolicLink()).toBe(true)
      if (kind === "dangling symlink") expect(fs.existsSync(target)).toBe(false)
      else expect(fs.readFileSync(target, "utf8")).toBe("unchanged")
    } else {
      expect(result.success).toBe(true)
      expect(JSON.parse(fs.readFileSync(sidecarPath, "utf8"))).toMatchObject({ mode: "cdp", artifactType: "webm", tabId: 1 })
    }
  } finally {
    await relay.cancelRecording({ tabId: 1 })
    if (previousOutput === undefined) delete process.env.OPENCODE_BROWSER_OUTPUT_DIR
    else process.env.OPENCODE_BROWSER_OUTPUT_DIR = previousOutput
    fs.rmSync(root, { recursive: true, force: true })
  }
})
