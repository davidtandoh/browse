// Applies the operator guards (operator-guards.ts) to the MCP server's tools, in the server rather than the client:
// tools an operator leaves out are never registered, and the session lock and output directory are checked before a
// tool's own handler runs, so no tool input can get around them.
import { Effect } from "effect"
import { normalizeOriginPatterns } from "../auth/domain-policy.ts"
import { assertOutputPath } from "../execute-realm/file-roots.ts"
import {
  OperatorGuardError,
  allowSecretsRunEnvironmentVariable,
  mcpToolAllowlist,
  mcpToolsEnvironmentVariable,
  outputDirectory,
  secretsRunAllowed,
  sessionLockEnvironmentVariable,
  sessionLocked,
} from "../operator-guards.ts"
import type { McpToolContext, McpToolSpec } from "./registry.ts"

/** Tools that would move a locked server off its session, or delete the session and its allowlist with it. */
const sessionLeavingTools = new Set(["session_new", "session_use", "session_delete"])

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}

/**
 * The tools this server registers, after the operator's guards. Throws OperatorGuardError on a configuration that
 * cannot be honoured (an unknown tool name, secrets_run listed but not allowed, a lock without a pinned session), so a
 * typo fails loudly instead of quietly exposing a different set of tools.
 */
export function applyOperatorGuards(specs: readonly McpToolSpec[], ctx: McpToolContext, env: NodeJS.ProcessEnv = process.env): readonly McpToolSpec[] {
  const allowlist = mcpToolAllowlist(env)
  const known = new Set(specs.map((spec) => spec.name))
  const unknown = allowlist ? [...allowlist].filter((name) => !known.has(name)) : []
  if (unknown.length > 0) {
    throw new OperatorGuardError(`${mcpToolsEnvironmentVariable} names unknown tools: ${unknown.join(", ")}. Tools: ${[...known].join(", ")}.`)
  }
  const secretsRun = secretsRunAllowed(env)
  if (allowlist?.has("secrets_run") && !secretsRun) {
    throw new OperatorGuardError(`${mcpToolsEnvironmentVariable} lists secrets_run, which stays off unless ${allowSecretsRunEnvironmentVariable}=1`)
  }
  const locked = sessionLocked(env)
  if (locked && !env.OPENCODE_BROWSER_SESSION) {
    throw new OperatorGuardError(`${sessionLockEnvironmentVariable}=1 needs OPENCODE_BROWSER_SESSION: the session the operator created, with its allowlist`)
  }
  const output = outputDirectory(env)
  return specs
    .filter((spec) => (spec.name !== "secrets_run" || secretsRun) && (!allowlist || allowlist.has(spec.name)))
    .map((spec) => !locked && output === undefined ? spec : {
      ...spec,
      handle: (input: unknown) => Effect.gen(function* () {
        const payload = locked ? yield* lockedInput(spec, input, ctx) : input
        const outputPath = record(payload).outputPath
        if (output !== undefined && typeof outputPath === "string") {
          yield* Effect.try({ try: () => assertOutputPath(outputPath, spec.name), catch: (cause) => cause as Error })
        }
        return yield* spec.handle(payload)
      }),
    })
}

/**
 * Under OPENCODE_BROWSER_SESSION_LOCK=1: refuses anything that names another session, and names the pinned session
 * explicitly otherwise, so a tool never creates it implicitly without the operator's allowlist.
 */
function lockedInput(spec: McpToolSpec, input: unknown, ctx: McpToolContext): Effect.Effect<unknown, Error> {
  return Effect.gen(function* () {
    const pinned = ctx.currentSession.id
    const refuse = (why: string) => Effect.fail(new OperatorGuardError(`${spec.name}: ${why}; ${sessionLockEnvironmentVariable}=1 pins this server to session '${pinned}'`))
    if (sessionLeavingTools.has(spec.name)) return yield* refuse("refused")
    const object = record(input)
    for (const field of spec.name === "session_reset" ? ["session", "id"] : ["session"]) {
      const value = object[field]
      if (value !== undefined && value !== pinned) return yield* refuse(`session ${JSON.stringify(value)} is not available`)
    }
    if (spec.name === "session_allowlist") yield* narrowingOnly(object.allowedOrigins, ctx, refuse)
    const properties = record(spec.inputSchema.properties)
    return "session" in properties && object.session === undefined ? { ...object, session: pinned } : input
  })
}

/** A locked allowlist may only drop entries: never be removed, and never gain an entry the session does not have. */
function narrowingOnly(
  requested: unknown,
  ctx: McpToolContext,
  refuse: (why: string) => Effect.Effect<never, Error>,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (!Array.isArray(requested) || !requested.every((item) => typeof item === "string")) return
    const patterns = yield* Effect.try({ try: () => normalizeOriginPatterns(requested), catch: (cause) => cause as Error })
    if (patterns.length === 0) return yield* refuse("the allowlist cannot be removed")
    const current = (yield* ctx.relay.sessions).find((session) => session.id === ctx.currentSession.id)?.allowedOrigins
    if (current === undefined) return
    const added = patterns.filter((pattern) => !current.includes(pattern))
    if (added.length > 0) return yield* refuse(`the allowlist can only narrow, and ${added.join(", ")} is not on it`)
  })
}
