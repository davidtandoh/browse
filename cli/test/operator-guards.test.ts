import "../src/mcp.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { assertOutputPath, assertExecuteFilePath, executeFileRoots } from "../src/execute-realm/file-roots.ts"
import { handleAuthRequest } from "../src/http-api/session-routes.ts"
import { applyOperatorGuards } from "../src/mcp/guards.ts"
import { buildRegisteredMcpTools, createMcpToolContext, type McpToolSpec } from "../src/mcp/registry.ts"
import { secretsRunDisabledMessage } from "../src/operator-guards.ts"
import type * as RelayClient from "../src/relay/client.ts"
import type { OpenCodeBrowserSessions } from "../src/session-manager.ts"

const pinned = "github-trial"
const roots: string[] = []
const savedEnv = new Map<string, string | undefined>()

/** Sets process.env for one test; afterEach restores it. The relay-side guards read process.env, as the relay does. */
function setEnv(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/** A private, real directory (macOS's TMPDIR is behind a /var symlink). */
function privateDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browse-guards-")))
  fs.chmodSync(dir, 0o700)
  roots.push(dir)
  return dir
}

type Call = { readonly method: string; readonly args: readonly unknown[] }

/** A relay that records the calls tools make, holding one session with `allowedOrigins`. */
function fakeRelay(allowedOrigins?: readonly string[]) {
  const calls: Call[] = []
  const session = { id: pinned, createdAt: "", updatedAt: "", connected: true, pageUrl: null, stateKeys: [], ...(allowedOrigins ? { allowedOrigins } : {}) }
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
    return Effect.succeed(method === "sessionAllowlist" ? { ...session, allowedOrigins: args[1] } : {})
  }
  const relay = {
    sessions: Effect.sync(() => [session]),
    sessionNew: record("sessionNew"),
    sessionAllowlist: record("sessionAllowlist"),
    sessionReset: record("sessionReset"),
    sessionDelete: record("sessionDelete"),
    sessionAdopt: record("sessionAdopt"),
    networkStop: record("networkStop"),
    recordingStart: record("recordingStart"),
  } as unknown as RelayClient.Interface
  return { relay, calls }
}

function guardedTools(env: NodeJS.ProcessEnv, relay: RelayClient.Interface = fakeRelay().relay): Map<string, McpToolSpec> {
  const ctx = createMcpToolContext({ relay, currentSession: { id: pinned, established: true }, packageRoot: "/tmp/browse" })
  return new Map(applyOperatorGuards(buildRegisteredMcpTools(ctx), ctx, env).map((spec) => [spec.name, spec]))
}

const call = (tools: Map<string, McpToolSpec>, name: string, input: unknown) => Effect.runPromiseExit(tools.get(name)!.handle(input))

function failure(exit: Exit.Exit<unknown, Error>): string {
  if (Exit.isSuccess(exit)) throw new Error("expected the call to fail")
  return String(exit.cause)
}

const allTools = buildRegisteredMcpTools(createMcpToolContext({
  relay: {} as RelayClient.Interface,
  currentSession: { id: pinned, established: true },
  packageRoot: "/tmp/browse",
})).map((spec) => spec.name)

describe("MCP tool allowlist (OPENCODE_BROWSER_MCP_TOOLS)", () => {
  test("unset or blank registers every tool except secrets_run", () => {
    const expected = allTools.filter((name) => name !== "secrets_run")
    expect([...guardedTools({}).keys()]).toEqual(expected)
    expect([...guardedTools({ OPENCODE_BROWSER_MCP_TOOLS: "  " }).keys()]).toEqual(expected)
  })

  test("registers only the listed tools, tolerating spaces and empty entries", () => {
    const tools = guardedTools({ OPENCODE_BROWSER_MCP_TOOLS: " execute , status,,session_adopt " })
    expect([...tools.keys()].sort()).toEqual(["execute", "session_adopt", "status"])
  })

  test("a single tool works", () => {
    expect([...guardedTools({ OPENCODE_BROWSER_MCP_TOOLS: "status" }).keys()]).toEqual(["status"])
  })

  test("an unknown tool name fails startup instead of exposing a different set", () => {
    expect(() => guardedTools({ OPENCODE_BROWSER_MCP_TOOLS: "execute,exectue" })).toThrow("unknown tools: exectue")
  })
})

describe("secrets_run (OPENCODE_BROWSER_ALLOW_SECRETS_RUN)", () => {
  test("is registered only when the operator allows it", () => {
    expect(guardedTools({}).has("secrets_run")).toBe(false)
    expect(guardedTools({ OPENCODE_BROWSER_ALLOW_SECRETS_RUN: "true" }).has("secrets_run")).toBe(false)
    expect(guardedTools({ OPENCODE_BROWSER_ALLOW_SECRETS_RUN: "1" }).has("secrets_run")).toBe(true)
  })

  test("listing it in the tool allowlist without allowing it fails startup", () => {
    expect(() => guardedTools({ OPENCODE_BROWSER_MCP_TOOLS: "execute,secrets_run" })).toThrow("stays off unless OPENCODE_BROWSER_ALLOW_SECRETS_RUN=1")
    expect(guardedTools({ OPENCODE_BROWSER_MCP_TOOLS: "secrets_run", OPENCODE_BROWSER_ALLOW_SECRETS_RUN: "1" }).has("secrets_run")).toBe(true)
  })

  const authRunRequest = () => Object.assign(Readable.from([Buffer.from(JSON.stringify({ name: "missing", command: "/usr/bin/true", cwd: "/" }))]), {
    method: "POST",
    headers: { "content-type": "application/json" },
  }) as unknown as http.IncomingMessage
  const runAuth = () => Effect.runPromiseExit(handleAuthRequest({
    request: authRunRequest(),
    response: {} as http.ServerResponse,
    pathname: "/auth/run",
    sessions: {} as OpenCodeBrowserSessions,
  }))

  test("the relay refuses /auth/run, which `browse secrets run` uses too, unless allowed", async () => {
    setEnv({ OPENCODE_BROWSER_ALLOW_SECRETS_RUN: undefined })
    const exit = await runAuth()
    expect(failure(exit)).toContain(secretsRunDisabledMessage)
    expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as { status?: number }).status).toBe(403)
  })

  test("with the relay allowed, /auth/run gets past the guard", async () => {
    setEnv({ OPENCODE_BROWSER_ALLOW_SECRETS_RUN: "1", OPENCODE_BROWSER_HOME: privateDir() })
    // The profile does not exist, so the run fails on that, after the guard and before spawning anything.
    expect(failure(await runAuth())).not.toContain(secretsRunDisabledMessage)
  })
})

describe("session lock (OPENCODE_BROWSER_SESSION_LOCK=1)", () => {
  const locked = { OPENCODE_BROWSER_SESSION_LOCK: "1", OPENCODE_BROWSER_SESSION: pinned }

  test("needs a pinned session", () => {
    expect(() => guardedTools({ OPENCODE_BROWSER_SESSION_LOCK: "1" })).toThrow("needs OPENCODE_BROWSER_SESSION")
  })

  test("only 1 turns it on", async () => {
    const { relay, calls } = fakeRelay(["github.com"])
    const tools = guardedTools({ OPENCODE_BROWSER_SESSION_LOCK: "true" }, relay)
    expect(Exit.isSuccess(await call(tools, "session_allowlist", { allowedOrigins: [] }))).toBe(true)
    expect(calls.map((entry) => entry.method)).toEqual(["sessionAllowlist"])
  })

  test("refuses session_new, session_use and session_delete without reaching the relay", async () => {
    const { relay, calls } = fakeRelay(["github.com"])
    const tools = guardedTools(locked, relay)
    for (const [name, input] of [["session_new", {}], ["session_use", { id: "other" }], ["session_delete", {}], ["session_delete", { id: pinned }]] as const) {
      expect(failure(await call(tools, name, input))).toContain(`pins this server to session '${pinned}'`)
    }
    expect(calls).toEqual([])
  })

  test("refuses a tool aimed at another session, and allows the pinned one", async () => {
    const { relay, calls } = fakeRelay(["github.com"])
    const tools = guardedTools(locked, relay)
    expect(failure(await call(tools, "execute", { code: "1", session: "unfenced" }))).toContain(`session "unfenced" is not available`)
    expect(failure(await call(tools, "session_reset", { id: "unfenced" }))).toContain("is not available")
    expect(failure(await call(tools, "network", { action: "stop", session: "unfenced", outputPath: "/tmp/x.har" }))).toContain("is not available")
    expect(calls).toEqual([])
    expect(Exit.isSuccess(await call(tools, "session_reset", { id: pinned }))).toBe(true)
    expect(calls).toEqual([{ method: "sessionReset", args: [pinned] }])
  })

  test("names the pinned session explicitly, so a tool never creates it without the operator's allowlist", async () => {
    const { relay, calls } = fakeRelay(["github.com"])
    const tools = guardedTools(locked, relay)
    expect(Exit.isSuccess(await call(tools, "session_adopt", {}))).toBe(true)
    expect(calls).toEqual([{ method: "sessionAdopt", args: [{ sessionId: pinned, createIfMissing: false }] }])
  })

  test("the allowlist can drop entries but never be removed or widened", async () => {
    const { relay, calls } = fakeRelay(["github.com", "*.github.com"])
    const tools = guardedTools(locked, relay)
    expect(failure(await call(tools, "session_allowlist", { allowedOrigins: [] }))).toContain("cannot be removed")
    expect(failure(await call(tools, "session_allowlist", { allowedOrigins: ["github.com", "evil.example"] }))).toContain("evil.example is not on it")
    expect(failure(await call(tools, "session_allowlist", { allowedOrigins: ["*"] }))).toContain("allows every site")
    expect(calls).toEqual([])
    // Patterns compare in their normalized form, as the relay stores them.
    expect(Exit.isSuccess(await call(tools, "session_allowlist", { allowedOrigins: ["GitHub.com"] }))).toBe(true)
    expect(calls).toEqual([{ method: "sessionAllowlist", args: [pinned, ["GitHub.com"]] }])
  })

  test("a pinned session without an allowlist can gain one", async () => {
    const { relay, calls } = fakeRelay()
    const tools = guardedTools(locked, relay)
    expect(Exit.isSuccess(await call(tools, "session_allowlist", { allowedOrigins: ["github.com"] }))).toBe(true)
    expect(calls.map((entry) => entry.method)).toEqual(["sessionAllowlist"])
  })
})

describe("output directory (OPENCODE_BROWSER_OUTPUT_DIR)", () => {
  test("must be absolute", () => {
    expect(() => guardedTools({ OPENCODE_BROWSER_OUTPUT_DIR: "artifacts" })).toThrow("must be an absolute path")
  })

  test("MCP tools write HARs and recordings only inside it", async () => {
    const output = privateDir()
    const { relay, calls } = fakeRelay()
    const tools = guardedTools({ OPENCODE_BROWSER_OUTPUT_DIR: output }, relay)
    setEnv({ OPENCODE_BROWSER_OUTPUT_DIR: output })
    expect(failure(await call(tools, "network", { action: "stop", outputPath: path.join(privateDir(), "a.har") }))).toContain("is outside")
    expect(failure(await call(tools, "recording", { action: "start", outputPath: path.join(output, "..", "escape.webm") }))).toContain("is outside")
    expect(failure(await call(tools, "flight_recorder", { action: "save_last", outputPath: "/etc/clip.webm" }))).toContain("is outside")
    expect(calls).toEqual([])
    const inside = path.join(output, "trial", "billing.har")
    expect(Exit.isSuccess(await call(tools, "network", { action: "stop", outputPath: inside }))).toBe(true)
    expect(calls).toEqual([{ method: "networkStop", args: [{ sessionId: pinned, outputPath: inside }] }])
  })

  test("unset leaves output paths as they were", () => {
    setEnv({ OPENCODE_BROWSER_OUTPUT_DIR: undefined })
    expect(assertOutputPath("/anywhere/x.har", "network stop")).toBe("/anywhere/x.har")
  })

  test("a symlink inside it that points outside is refused", () => {
    const output = privateDir()
    const outside = privateDir()
    fs.symlinkSync(outside, path.join(output, "link"))
    setEnv({ OPENCODE_BROWSER_OUTPUT_DIR: output })
    expect(() => assertOutputPath(path.join(output, "link", "x.har"), "network stop")).toThrow("is outside")
    expect(assertOutputPath(path.join(output, "x.har"), "network stop")).toBe(path.join(output, "x.har"))
  })

  test("browse's own folders stay off limits even inside it", () => {
    const output = privateDir()
    setEnv({ OPENCODE_BROWSER_OUTPUT_DIR: output, OPENCODE_BROWSER_HOME: output })
    expect(() => assertOutputPath(path.join(output, ".local", "share", "browse", "relay-token"), "network stop")).toThrow("is outside")
  })

  test("it replaces the execute file roots, so screenshots and files land only there", () => {
    const output = privateDir()
    setEnv({ OPENCODE_BROWSER_OUTPUT_DIR: output, OPENCODE_BROWSER_FILE_ROOTS: privateDir() })
    expect(executeFileRoots()).toEqual([output])
    const shot = path.join(output, "shots", "page.png")
    expect(assertExecuteFilePath(shot, "page.screenshot({ path })")).toBe(shot)
    expect(() => assertExecuteFilePath(path.join(os.tmpdir(), "x", "page.png"), "page.screenshot({ path })")).toThrow("OPENCODE_BROWSER_OUTPUT_DIR")
  })
})
