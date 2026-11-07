// Operator guards: limits the person who configures browse sets in the environment, which an agent cannot change
// through MCP. Each is off unless its variable is set, except secrets_run, which stays off unless the operator turns it
// on. The MCP server reads them from its own environment (the MCP client's server entry); the relay reads them from the
// environment it started with, which carries every OPENCODE_BROWSER_* variable of the process that started it.
import path from "node:path"

/** Comma-separated MCP tool names the server registers; every other tool is left out. */
export const mcpToolsEnvironmentVariable = "OPENCODE_BROWSER_MCP_TOOLS"
/** `1` pins the MCP server to OPENCODE_BROWSER_SESSION: it cannot switch sessions, and its allowlist can only narrow. */
export const sessionLockEnvironmentVariable = "OPENCODE_BROWSER_SESSION_LOCK"
/** `1` allows secrets_run (the MCP tool and `browse secrets run`), which runs host commands with captured secrets. */
export const allowSecretsRunEnvironmentVariable = "OPENCODE_BROWSER_ALLOW_SECRETS_RUN"
/** Absolute directory every file browse writes for an agent (HARs, recordings, execute files and screenshots) must be inside. */
export const outputDirectoryEnvironmentVariable = "OPENCODE_BROWSER_OUTPUT_DIR"

export class OperatorGuardError extends Error {
  override readonly name = "OperatorGuardError"
}

/** The tool names OPENCODE_BROWSER_MCP_TOOLS allows, or undefined when it is unset or blank (every tool). */
export function mcpToolAllowlist(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | undefined {
  const raw = env[mcpToolsEnvironmentVariable]
  if (raw === undefined || raw.trim() === "") return undefined
  return new Set(raw.split(",").map((name) => name.trim()).filter(Boolean))
}

export const sessionLocked = (env: NodeJS.ProcessEnv = process.env): boolean => env[sessionLockEnvironmentVariable] === "1"

export const secretsRunAllowed = (env: NodeJS.ProcessEnv = process.env): boolean => env[allowSecretsRunEnvironmentVariable] === "1"

export const secretsRunDisabledMessage =
  `secrets_run is turned off: it runs host commands outside the agent's sandbox. The operator can allow it by starting browse (and its relay) with ${allowSecretsRunEnvironmentVariable}=1.`

/** The configured output directory, or undefined when unset. Throws when it is set but not an absolute path. */
export function outputDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[outputDirectoryEnvironmentVariable]
  if (raw === undefined || raw.trim() === "") return undefined
  if (!path.isAbsolute(raw)) throw new OperatorGuardError(`${outputDirectoryEnvironmentVariable} must be an absolute path (got ${JSON.stringify(raw)})`)
  return path.resolve(raw)
}
