import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { RecordingRelay } from "../src/recording-relay.ts"
import { FlightRecorderRelay } from "../src/recording-relay/flight-recorder.ts"

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

test.each(["new", "dangling symlink", "late outside symlink", "late inside symlink", "late existing"])("flight recorder metadata: %s", async (kind) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".flight-sidecar-"))
  const previousOutput = process.env.OPENCODE_BROWSER_OUTPUT_DIR
  const output = path.join(root, "output")
  fs.mkdirSync(output, { mode: 0o700 })
  process.env.OPENCODE_BROWSER_OUTPUT_DIR = output
  const outputPath = path.join(output, "clip.webm")
  const sidecarPath = `${outputPath}.json`
  const target = path.join(kind === "late inside symlink" ? output : root, "target.json")
  const recorder = new FlightRecorderRelay({
    isExtensionConnected: () => true,
    sendDebuggerCommand: async () => ({}),
    startVideoEncoder: async () => ({
      write: async () => {},
      finish: async () => {
        fs.writeFileSync(outputPath, "video")
        if (kind === "late existing") fs.writeFileSync(sidecarPath, "unchanged")
        else if (kind.startsWith("late")) {
          fs.writeFileSync(target, "unchanged")
          fs.symlinkSync(target, sidecarPath)
        }
      },
      cancel: async () => {},
    }),
  })
  try {
    await recorder.start({ tabId: 1 })
    recorder.handleDebuggerEvent({ tabId: 1, method: "Page.screencastFrame", params: { sessionId: 1, data: Buffer.from("frame").toString("base64") } })
    if (kind === "dangling symlink") fs.symlinkSync(target, sidecarPath)
    const save = recorder.saveLast({ tabId: 1, outputPath })
    if (kind === "new") {
      const receipt = await save
      expect(JSON.parse(fs.readFileSync(sidecarPath, "utf8"))).toMatchObject({ path: receipt.path, frameCount: 1 })
    } else {
      await expect(save).rejects.toThrow()
      if (kind === "late existing") expect(fs.readFileSync(sidecarPath, "utf8")).toBe("unchanged")
      else {
        expect(fs.lstatSync(sidecarPath).isSymbolicLink()).toBe(true)
        if (kind === "dangling symlink") expect(fs.existsSync(target)).toBe(false)
        else expect(fs.readFileSync(target, "utf8")).toBe("unchanged")
      }
    }
  } finally {
    await recorder.cancel({ tabId: 1 })
    if (previousOutput === undefined) delete process.env.OPENCODE_BROWSER_OUTPUT_DIR
    else process.env.OPENCODE_BROWSER_OUTPUT_DIR = previousOutput
    fs.rmSync(root, { recursive: true, force: true })
  }
})
