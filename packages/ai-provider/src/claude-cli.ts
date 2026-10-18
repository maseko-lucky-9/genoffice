import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import type { AiChatResponse, AiProviderConfig } from './types'
import {
  MAX_RPC_LINE_BYTES,
  buildCodexAppServerPrompt,
  codexAppServerOutputSchema,
  commonUnixBinDirs,
  executableOnPath,
  parseCodexAppServerTurn,
} from './codex-app-server'
import { isPlainObject, type StreamCallbacks } from './protocols/shared'
import { AI_WATCHDOG_MAX_TIMEOUT_MS, AiTimeoutError } from './watchdog'

interface ClaudeCliResult {
  is_error?: unknown
  result?: unknown
  structured_output?: unknown
}

interface ClaudeCliExit {
  stdout: string
  code: number | null
  /** stderr tail, or the stdin write error when the CLI printed nothing */
  detail: string
}

interface ClaudeCliOutput {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
}

/** The slice of a spawned child this bridge uses; tests drive a fake one. */
export interface ClaudeCliChild {
  stdin: {
    on(event: 'error', listener: (error: Error) => void): unknown
    write(chunk: string): unknown
    end(): unknown
  }
  stdout: ClaudeCliOutput
  stderr: ClaudeCliOutput
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
}

export type ClaudeCliSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ClaudeCliChild

export interface ClaudeCliOptions {
  /** Test seam; the real child_process.spawn by default. */
  spawn?: ClaudeCliSpawn | undefined
  /** Absolute budget for one turn: the JSON result only arrives once the turn is done. */
  timeoutMs?: number | undefined
  /** Host environment the CLI is found and launched from; process.env by default. */
  env?: NodeJS.ProcessEnv | undefined
}

const BACKEND = 'Claude Code'
const DEFAULT_MODEL = 'sonnet'
const STDERR_TAIL_LIMIT = 4_000
/** Silence the renderer tolerates is 240 s; the CLI prints nothing until the turn is done. */
const HEARTBEAT_MS = 30_000
/** Grace between SIGTERM and SIGKILL for a child that ignores the first. */
const KILL_GRACE_MS = 5_000
const NOT_FOUND_MESSAGE =
  'Claude Code CLI was not found. Install it and run `claude` once to log in.'
const NOT_LOGGED_IN_MESSAGE =
  'Claude Code is not logged in. Run `claude` in a terminal and use /login, then try again.'
const LOGIN_ERROR = /not logged in|\/login|oauth|authenticat/i
/**
 * What the CLI needs to find its login, locale, network proxy and corporate CA.
 * Everything else is dropped: an inherited ANTHROPIC_API_KEY would silently
 * move billing off the subscription, and the CLAUDECODE / CLAUDE_CODE_* markers
 * of a parent session change how the CLI behaves. Unix names only: Windows
 * (USERPROFILE, APPDATA, SystemRoot) is not supported by this bridge.
 */
const ENV_ALLOWLIST = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'CLAUDE_CONFIG_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  ...['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY'].flatMap((name) => [
    name,
    name.toLowerCase(),
  ]),
])

export const CLAUDE_BASE_INSTRUCTIONS =
  'You are the language-model backend embedded in GenOffice. Never inspect or modify local files, run shell commands, browse, or call MCP. The caller supplies the complete relevant conversation and a JSON Schema. Return exactly one assistant response matching that schema; GenOffice itself executes document tools.'

export function claudeCliArgs(model: string, tools: AgentToolDef[]): string[] {
  return [
    '-p',
    // Skips the user's CLAUDE.md, hooks, plugins and MCP servers but keeps the
    // OAuth login. Never --bare: it ignores the subscription login entirely.
    '--safe-mode',
    // Variadic, so the empty value must be closed by the next option.
    '--tools',
    '',
    // No user, project or local settings: their env or apiKeyHelper could move
    // billing off the subscription. The OAuth login is not a setting and stays.
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(codexAppServerOutputSchema(tools)),
    '--system-prompt',
    CLAUDE_BASE_INSTRUCTIONS,
    // Safe mode keeps the settings-level model and effort, so both are pinned.
    '--model',
    model.trim() || DEFAULT_MODEL,
    '--effort',
    'medium',
  ]
}

export async function claudeCliEnv(
  env: NodeJS.ProcessEnv,
  cliPath = '',
): Promise<NodeJS.ProcessEnv> {
  const child: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (ENV_ALLOWLIST.has(name) || name.startsWith('LC_')) child[name] = value
  }
  const inherited = (env.PATH ?? '').split(delimiter).filter(Boolean)
  // An npm-installed CLI is a node script: the node beside it must win.
  const pinned = isAbsolute(cliPath) ? [dirname(cliPath)] : []
  const dirs = [...pinned, ...inherited, ...(await commonUnixBinDirs(env))]
  child.PATH = [...new Set(dirs)].join(delimiter)
  // A self-update must not start inside a one-shot run.
  child.DISABLE_AUTOUPDATER = '1'
  return child
}

export async function resolveClaudeCliPath(
  configuredPath?: string,
  options: { platform?: NodeJS.Platform | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<string> {
  const configured = (configuredPath ?? '').trim()
  if (configured) {
    // A bare command resolves via PATH at spawn time. A relative path would
    // resolve against the private cwd, and a stale absolute one is gone: both
    // fall back to discovery.
    if (!/[\\/]/.test(configured)) return configured
    if (isAbsolute(configured) && (await stat(configured).catch(() => null))?.isFile()) {
      return configured
    }
  }
  const found = await executableOnPath(
    'claude',
    options.platform ?? process.platform,
    options.env ?? process.env,
  )
  if (found) return found
  throw new Error(NOT_FOUND_MESSAGE)
}

function cancelledError(): Error {
  const error = new Error('Claude Code request was cancelled')
  error.name = 'AbortError'
  return error
}

const spawnClaudeCli: ClaudeCliSpawn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

/** A user-private working dir, so no project's .claude files apply and no other user shares it. */
function claudeCliCwd(env: NodeJS.ProcessEnv): string {
  return join(env.HOME || homedir(), '.genoffice', 'claude-cli')
}

function runChild(
  child: ClaudeCliChild,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
  onActivity?: () => void,
): Promise<ClaudeCliExit> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let stdinError: Error | undefined
    let settled = false
    let exited = false
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      clearInterval(heartbeat)
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const fail = (error: Error) => {
      if (settle()) reject(error)
    }
    const kill = (killSignal?: NodeJS.Signals) => {
      try {
        child.kill(killSignal)
      } catch {
        /* already gone */
      }
    }
    const stop = (error: Error) => {
      kill()
      const escalate = setTimeout(() => {
        if (!exited) kill('SIGKILL')
      }, KILL_GRACE_MS)
      escalate.unref?.()
      fail(error)
    }
    const onAbort = () => stop(cancelledError())
    const timer = setTimeout(() => stop(new AiTimeoutError(timeoutMs)), timeoutMs)
    const heartbeat = onActivity ? setInterval(onActivity, HEARTBEAT_MS) : undefined
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) =>
      fail(error.code === 'ENOENT' ? new Error(NOT_FOUND_MESSAGE) : error),
    )
    // EPIPE when the CLI exits without reading its input; its exit then says why.
    child.stdin.on('error', (error) => {
      stdinError = error
    })
    child.stdout.on('data', (chunk) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > MAX_RPC_LINE_BYTES) {
        stop(
          new Error(
            `Claude Code CLI output exceeded ${MAX_RPC_LINE_BYTES} bytes; the child was stopped`,
          ),
        )
      } else {
        chunks.push(chunk)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
    })
    child.on('close', (code) => {
      exited = true
      if (!settle()) return
      const stdout = Buffer.concat(chunks).toString('utf8')
      resolve({ stdout, code, detail: stderr.trim() || stdinError?.message || '' })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

function turnFromExit(
  exit: ClaudeCliExit,
  tools: AgentToolDef[],
): { text: string; toolCalls: AgentToolCall[] } {
  let result: ClaudeCliResult | undefined
  try {
    const value: unknown = JSON.parse(exit.stdout)
    if (isPlainObject(value)) result = value
  } catch {
    // not the CLI's JSON result; the exit message below reports it
  }
  const detail = exit.detail ? `: ${exit.detail}` : ''
  const exitMessage = `Claude Code CLI exited with code ${exit.code ?? 'unknown'}${detail}`
  // `subtype` says success even for a failed login, so `is_error` is the signal.
  if (result?.is_error === true) {
    const message = typeof result.result === 'string' ? result.result.trim() : ''
    if (!message) throw new Error(exitMessage)
    throw new Error(LOGIN_ERROR.test(message) ? NOT_LOGGED_IN_MESSAGE : message)
  }
  // structured_output is the CLI's schema-validated object; `result` is only its text encoding.
  const raw = isPlainObject(result?.structured_output)
    ? JSON.stringify(result.structured_output)
    : typeof result?.result === 'string'
      ? result.result
      : undefined
  if (raw === undefined) throw new Error(exitMessage)
  return parseCodexAppServerTurn(raw, tools, BACKEND)
}

/**
 * One headless `claude -p` run per turn: the GenOffice conversation goes in on
 * stdin, the schema-shaped reply comes back as a single JSON result, and
 * GenOffice executes the tool calls itself. Abort and the absolute timeout kill
 * the child; spawn and pipe errors reject instead of reaching the main process.
 */
export async function runClaudeCli(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  signal: AbortSignal,
  options: ClaudeCliOptions = {},
  onActivity?: () => void,
): Promise<{ text: string; toolCalls: AgentToolCall[] }> {
  const env = options.env ?? process.env
  const cliPath = await resolveClaudeCliPath(config.cliPath, { env })
  const childEnv = await claudeCliEnv(env, cliPath)
  const cwd = claudeCliCwd(env)
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const prompt = buildCodexAppServerPrompt(system, messages, tools, maxTokens, BACKEND)
  if (signal.aborted) throw cancelledError()
  const child = (options.spawn ?? spawnClaudeCli)(cliPath, claudeCliArgs(config.model, tools), {
    cwd,
    env: childEnv,
  })
  const timeoutMs = options.timeoutMs ?? AI_WATCHDOG_MAX_TIMEOUT_MS
  return turnFromExit(await runChild(child, prompt, signal, timeoutMs, onActivity), tools)
}

export async function streamClaudeCli(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  options: ClaudeCliOptions = {},
): Promise<void> {
  const turn = await runClaudeCli(
    config,
    system,
    messages,
    tools,
    maxTokens,
    cb.signal,
    options,
    cb.onActivity,
  )
  if (turn.text) cb.onDelta(turn.text)
  for (const call of turn.toolCalls) cb.onToolCall(call)
}

export async function chatClaudeCli(
  config: AiProviderConfig,
  system: string,
  user: string,
  signal: AbortSignal,
  options: ClaudeCliOptions = {},
): Promise<AiChatResponse> {
  const turn = await runClaudeCli(
    config,
    system,
    [{ role: 'user', text: user }],
    [],
    1024,
    signal,
    options,
  )
  // an empty turn never gets here: parseCodexAppServerTurn rejects it as "returned no content"
  return { ok: true, content: turn.text }
}
