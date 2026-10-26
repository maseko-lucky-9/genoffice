import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import {
  CLAUDE_BASE_INSTRUCTIONS,
  chatClaudeCli,
  claudeCliArgs,
  claudeCliEnv,
  resolveClaudeCliPath,
  streamClaudeCli,
  type ClaudeCliOptions,
  type ClaudeCliSpawn,
} from '../src/claude-cli'
import { codexAppServerOutputSchema, MAX_RPC_LINE_BYTES } from '../src/codex-app-server'
import { AiTimeoutError } from '../src/watchdog'

const tools: AgentToolDef[] = [
  {
    name: 'set_bold',
    description: 'Make a paragraph bold',
    inputSchema: {
      type: 'object',
      properties: { paragraphId: { type: 'string' } },
      required: ['paragraphId'],
    },
  },
]

/**
 * Trimmed from real `claude -p --output-format json` runs (claude 2.1.302). The
 * recorded `result` is the compact JSON encoding of `structured_output`.
 */
const S1A_STRUCTURED = {
  text: 'I\'ve made the title "Quarterly Report" bold.',
  toolCalls: [{ id: 'call_1', name: 'set_bold', inputJson: '{"paragraphId":"p1"}' }],
}
const S1A = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  num_turns: 2,
  duration_ms: 1909,
  stop_reason: 'tool_use',
  terminal_reason: 'completed',
  session_id: '744ad5d2-e384-4a44-8ced-4e3ac569d73d',
  total_cost_usd: 0.007914000000000001,
  result: JSON.stringify(S1A_STRUCTURED),
  structured_output: S1A_STRUCTURED,
}
const S1B_STRUCTURED = {
  text: '**Quarterly Performance Review**\n\nOther options:\n- Quarterly Sales Insights\n- Revenue Growth Report\n- Sales Results Snapshot',
  toolCalls: [],
}
const S1B = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  num_turns: 2,
  duration_ms: 1978,
  stop_reason: 'tool_use',
  terminal_reason: 'completed',
  session_id: '78600b72-8845-454f-aaff-0147dac96311',
  total_cost_usd: 0.006946,
  result: JSON.stringify(S1B_STRUCTURED),
  structured_output: S1B_STRUCTURED,
}
/** Recorded with no login: the CLI exits 1, and `subtype` still says success. */
const S5_NOT_LOGGED_IN = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: null,
  num_turns: 1,
  duration_ms: 25,
  stop_reason: 'stop_sequence',
  terminal_reason: 'api_error',
  session_id: '84ae94f6-182e-4ffd-9cc5-a8861d02d416',
  total_cost_usd: 0,
  result: 'Not logged in · Please run /login',
}

class FakeStdin extends EventEmitter {
  written = ''
  ended = false
  write(chunk: string): boolean {
    this.written += chunk
    return true
  }
  end(): void {
    this.ended = true
  }
}

/** A child whose output is driven by the test, with a kill spy. */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin()
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []
  get killed(): number {
    return this.signals.length
  }
  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM')
    return true
  }
  /** print the CLI's output and exit, the way the real process does */
  exit(stdout: string, code: number, stderr = ''): void {
    if (stderr) this.stderr.emit('data', Buffer.from(stderr))
    if (stdout) this.stdout.emit('data', Buffer.from(stdout))
    this.emit('close', code)
  }
}

interface Spawned {
  command: string
  args: string[]
  options: { cwd: string; env: NodeJS.ProcessEnv }
  child: FakeChild
}

/** Spawn seam: records the launch and runs `script` against the child once it is wired up. */
function fakeSpawn(script: (child: FakeChild) => void) {
  const spawned: Spawned[] = []
  const spawn: ClaudeCliSpawn = (command, args, options) => {
    const child = new FakeChild()
    spawned.push({ command, args, options, child })
    setImmediate(() => script(child))
    return child
  }
  return { spawn, spawned }
}

/** A throwaway HOME: the bridge creates its private working dir under it. */
let testHome = ''
const hostEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  ANTHROPIC_API_KEY: 'anthropic-key-must-not-leak',
  CLAUDECODE: '1',
}

beforeAll(async () => {
  testHome = await mkdtemp(join(tmpdir(), 'genoffice-claude-run-'))
  hostEnv.HOME = testHome
})

afterAll(async () => {
  await rm(testHome, { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

/** The argv the bridge must launch with for `tools` and the sonnet model, spelled out. */
function expectedArgs(schemaTools: AgentToolDef[], model: string): string[] {
  return [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(codexAppServerOutputSchema(schemaTools)),
    '--system-prompt',
    CLAUDE_BASE_INSTRUCTIONS,
    '--model',
    model,
    '--effort',
    'medium',
  ]
}

/** Resolve once the fake child exists, while other timers may be faked. */
async function spawnedOnce(spawned: unknown[]): Promise<void> {
  // Bounded: an unbounded spin outlives the test timeout and pins a CPU in an orphaned worker.
  for (let i = 0; spawned.length === 0; i++) {
    if (i > 10_000) throw new Error('spawn was never called')
    await new Promise((r) => setImmediate(r))
  }
}

/** `cliPath: 'claude'` is a bare command, so no test depends on a real install. */
const config = { apiKey: '', model: 'sonnet', cliPath: 'claude' }

async function stream(
  script: (child: FakeChild) => void,
  options: Partial<ClaudeCliOptions> & { signal?: AbortSignal } = {},
) {
  const { spawn, spawned } = fakeSpawn(script)
  const deltas: string[] = []
  const calls: AgentToolCall[] = []
  const onActivity = vi.fn()
  const { signal, ...runOptions } = options
  const run = streamClaudeCli(
    config,
    'You edit documents.',
    [{ role: 'user', text: 'Make the title bold.' }],
    tools,
    4096,
    {
      signal: signal ?? new AbortController().signal,
      onDelta: (text) => deltas.push(text),
      onToolCall: (call) => calls.push(call),
      onActivity,
    },
    { spawn, env: hostEnv, ...runOptions },
  )
  return { run, spawned, deltas, calls, onActivity }
}

describe('claudeCliArgs', () => {
  it('builds the exact headless argv', () => {
    expect(claudeCliArgs('opus', tools)).toEqual([
      '-p',
      '--safe-mode',
      '--tools',
      '',
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
      '--model',
      'opus',
      '--effort',
      'medium',
    ])
  })

  it('never passes an empty model', () => {
    for (const model of ['', '   ']) {
      const args = claudeCliArgs(model, tools)
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
    }
    const args = claudeCliArgs(' haiku ', tools)
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
  })

  it('keeps the isolation flags and never disables the subscription login', () => {
    const args = claudeCliArgs('sonnet', [])
    expect(args).toContain('--safe-mode')
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--bare')
    // no user, project or local settings: none of them may redirect auth or billing
    const sources = args.indexOf('--setting-sources')
    expect(args[sources + 1]).toBe('')
    expect(args[sources + 2]).toMatch(/^--/)
    // --tools is variadic: the empty value must be closed by the next option
    const tool = args.indexOf('--tools')
    expect(args[tool + 1]).toBe('')
    expect(args[tool + 2]).toMatch(/^--/)
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(
      codexAppServerOutputSchema([]),
    )
    expect(args[args.indexOf('--effort') + 1]).toBe('medium')
  })

  it('does not tell Claude about Codex', () => {
    expect(CLAUDE_BASE_INSTRUCTIONS).not.toMatch(/codex/i)
  })

  // --json-schema runs a StructuredOutput tool loop; without this Claude calls the
  // listed GenOffice tools directly, gets "No such tool available" and reports the
  // tools as unavailable (Slides e2e: 4 of 6 replays failed, 0 of 6 with this text)
  it('tells Claude the GenOffice tools are only reachable through toolCalls', () => {
    expect(CLAUDE_BASE_INSTRUCTIONS).toMatch(/not callable tools/)
    expect(CLAUDE_BASE_INSTRUCTIONS).toMatch(/only callable tool is StructuredOutput/)
    expect(CLAUDE_BASE_INSTRUCTIONS).toMatch(/list it in toolCalls/)
  })
})

describe('claudeCliEnv', () => {
  it('passes only the login and locale allowlist, with PATH augmented', async () => {
    const home = '/nonexistent/genoffice-test-home'
    const env = await claudeCliEnv({
      HOME: home,
      USER: 'tester',
      LOGNAME: 'tester',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp/tester/',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      PATH: '/usr/bin:/bin',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_EFFORT: 'high',
      OPENAI_API_KEY: 'openai-key',
      FOO: 'bar',
      HTTPS_PROXY: 'http://proxy:3128',
      https_proxy: 'http://proxy:3128',
      HTTP_PROXY: 'http://proxy:3128',
      http_proxy: 'http://proxy:3128',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      ALL_PROXY: 'socks5://proxy:1080',
      all_proxy: 'socks5://proxy:1080',
      NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
      SSL_CERT_FILE: '/etc/corp-ca.pem',
      CLAUDE_CONFIG_DIR: '/Users/tester/.claude-work',
    })
    expect(Object.keys(env).sort()).toEqual(
      [
        'ALL_PROXY',
        'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'LOGNAME',
        'NODE_EXTRA_CA_CERTS',
        'NO_PROXY',
        'PATH',
        'SHELL',
        'SSL_CERT_FILE',
        'TMPDIR',
        'USER',
        'all_proxy',
        'http_proxy',
        'https_proxy',
        'no_proxy',
      ].sort(),
    )
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/tester/.claude-work')
    expect(env).toMatchObject({
      HOME: home,
      USER: 'tester',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: '/tmp/tester/',
      DISABLE_AUTOUPDATER: '1',
    })
    const path = env.PATH!.split(delimiter)
    expect(path.slice(0, 2)).toEqual(['/usr/bin', '/bin'])
    expect(path).toContain(join(home, '.local', 'bin'))
    expect(path).toContain('/opt/homebrew/bin')
  })

  it('puts the directory of an absolute CLI path first, so its own runtime is found', async () => {
    const env = { HOME: '/nonexistent/h', PATH: '/usr/bin:/bin' }
    const pinned = (await claudeCliEnv(env, '/opt/claude/bin/claude')).PATH!.split(delimiter)
    expect(pinned.slice(0, 3)).toEqual(['/opt/claude/bin', '/usr/bin', '/bin'])
    const bare = (await claudeCliEnv(env, 'claude')).PATH!.split(delimiter)
    expect(bare.slice(0, 2)).toEqual(['/usr/bin', '/bin'])
  })
})

describe('streamClaudeCli', () => {
  it('writes the prompt to stdin, closes it, and emits the recorded turn', async () => {
    const { run, spawned, deltas, calls } = await stream((child) =>
      child.exit(JSON.stringify(S1A), 0),
    )
    await run
    expect(deltas).toEqual([S1A_STRUCTURED.text])
    expect(calls).toEqual([{ id: 'call_1', name: 'set_bold', input: { paragraphId: 'p1' } }])

    const [launch] = spawned
    expect(launch!.command).toBe('claude')
    expect(launch!.args).toEqual(expectedArgs(tools, 'sonnet'))
    const cwd = join(testHome, '.genoffice', 'claude-cli')
    expect(launch!.options.cwd).toBe(cwd)
    expect(statSync(cwd).mode & 0o777).toBe(0o700)
    expect(launch!.options.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(launch!.options.env.CLAUDECODE).toBeUndefined()
    expect(launch!.options.env.DISABLE_AUTOUPDATER).toBe('1')
    const { stdin } = launch!.child
    expect(stdin.ended).toBe(true)
    expect(stdin.written).toContain('<genoffice_payload>')
    expect(stdin.written).toContain('You edit documents.')
    expect(stdin.written).toContain('Make the title bold.')
    expect(stdin.written).toContain('set_bold')
    expect(stdin.written).not.toMatch(/codex/i)
  })

  it('emits text only for a turn without tool calls', async () => {
    const { run, deltas, calls } = await stream((child) => child.exit(JSON.stringify(S1B), 0))
    await run
    expect(deltas).toEqual([S1B_STRUCTURED.text])
    expect(calls).toEqual([])
  })

  it('prefers structured_output over the result string', async () => {
    const envelope = {
      ...S1B,
      result: JSON.stringify({ text: 'stale result text', toolCalls: [] }),
      structured_output: { text: 'validated structured output', toolCalls: [] },
    }
    const { run, deltas } = await stream((child) => child.exit(JSON.stringify(envelope), 0))
    await run
    expect(deltas).toEqual(['validated structured output'])
  })

  it('falls back to a fenced JSON result when there is no structured_output', async () => {
    const { structured_output: _omitted, ...envelope } = S1B
    const fenced = {
      ...envelope,
      result: '```json\n{"text":"from the fenced result","toolCalls":[]}\n```',
    }
    const { run, deltas } = await stream((child) => child.exit(JSON.stringify(fenced), 0))
    await run
    expect(deltas).toEqual(['from the fenced result'])
  })

  it('rejects a tool GenOffice did not offer', async () => {
    const envelope = {
      ...S1A,
      structured_output: {
        text: '',
        toolCalls: [{ id: 'x', name: 'Bash', inputJson: '{"command":"ls"}' }],
      },
    }
    const { run, calls } = await stream((child) => child.exit(JSON.stringify(envelope), 0))
    await expect(run).rejects.toThrow('Claude Code requested an unknown tool: Bash')
    expect(calls).toEqual([])
  })

  it('turns the recorded not-logged-in result into a /login hint', async () => {
    const { run, deltas } = await stream((child) => child.exit(JSON.stringify(S5_NOT_LOGGED_IN), 1))
    await expect(run).rejects.toThrow(
      'Claude Code is not logged in. Run `claude` in a terminal and use /login, then try again.',
    )
    expect(deltas).toEqual([])
  })

  it('passes any other CLI error through unchanged', async () => {
    const limited = {
      ...S5_NOT_LOGGED_IN,
      terminal_reason: 'completed',
      result: 'Claude usage limit reached. Your limit will reset at 11pm.',
    }
    const { run } = await stream((child) => child.exit(JSON.stringify(limited), 1))
    await expect(run).rejects.toThrow(
      /^Claude usage limit reached\. Your limit will reset at 11pm\.$/,
    )
  })

  it('reports a missing executable with the install hint', async () => {
    const { run } = await stream((child) =>
      child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })),
    )
    await expect(run).rejects.toThrow(
      'Claude Code CLI was not found. Install it and run `claude` once to log in.',
    )
  })

  it('kills the child when the caller aborts', async () => {
    const controller = new AbortController()
    const { run, spawned } = await stream(() => controller.abort(), { signal: controller.signal })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned[0]!.child.killed).toBe(1)
  })

  it('keeps the renderer watchdog alive with a heartbeat while the CLI runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let child: FakeChild | undefined
    const { run, spawned, onActivity } = await stream((c) => {
      child = c
    })
    await spawnedOnce(spawned)
    await new Promise((r) => setImmediate(r))
    vi.advanceTimersByTime(29_999)
    expect(onActivity).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onActivity).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(onActivity).toHaveBeenCalledTimes(3)
    child!.exit(JSON.stringify(S1B), 0)
    await run
    vi.advanceTimersByTime(120_000)
    expect(onActivity).toHaveBeenCalledTimes(3)
  })

  it('escalates to SIGKILL when a stopped child does not exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const { run, spawned } = await stream(() => controller.abort(), { signal: controller.signal })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    const { child } = spawned[0]!
    expect(child.signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(4_999)
    expect(child.signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('does not SIGKILL a stopped child that exits in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const { run, spawned } = await stream(
      (child) => {
        controller.abort()
        child.emit('close', null)
      },
      { signal: controller.signal },
    )
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    vi.advanceTimersByTime(10_000)
    expect(spawned[0]!.child.signals).toEqual(['SIGTERM'])
  })

  it('does not start the CLI for an already aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    const { run, spawned } = await stream(() => undefined, { signal: controller.signal })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned).toEqual([])
  })

  it('kills the child and times out when no result arrives', async () => {
    const { run, spawned } = await stream(() => undefined, { timeoutMs: 20 })
    await expect(run).rejects.toBeInstanceOf(AiTimeoutError)
    expect(spawned[0]!.child.killed).toBe(1)
  })

  it('rejects instead of throwing when stdin breaks and the CLI exits', async () => {
    const { run } = await stream((child) => {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      child.exit('', 1)
    })
    await expect(run).rejects.toThrow(/exited with code 1.*EPIPE/)
  })

  it('still reads the result when stdin broke after the CLI had its input', async () => {
    const { run, deltas } = await stream((child) => {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      child.exit(JSON.stringify(S1B), 0)
    })
    await run
    expect(deltas).toEqual([S1B_STRUCTURED.text])
  })

  it('includes the stderr tail when the output is not a result', async () => {
    const { run } = await stream((child) =>
      child.exit('this is not json', 2, 'Error: something failed upstream\n'),
    )
    await expect(run).rejects.toThrow(
      'Claude Code CLI exited with code 2: Error: something failed upstream',
    )
  })

  it('stops a child that floods stdout', async () => {
    const { run, spawned } = await stream((child) =>
      child.stdout.emit('data', Buffer.alloc(MAX_RPC_LINE_BYTES + 1, 0x61)),
    )
    await expect(run).rejects.toThrow(/exceeded/)
    expect(spawned[0]!.child.killed).toBe(1)
  })
})

describe('chatClaudeCli', () => {
  it('answers a one-shot chat with no tools offered', async () => {
    const { spawn, spawned } = fakeSpawn((child) => child.exit(JSON.stringify(S1B), 0))
    const reply = await chatClaudeCli(
      { apiKey: '', model: '', cliPath: 'claude' },
      'You are a connectivity test.',
      'ping',
      new AbortController().signal,
      { spawn, env: hostEnv },
    )
    expect(reply).toEqual({ ok: true, content: S1B_STRUCTURED.text })
    expect(spawned[0]!.args).toEqual(expectedArgs([], 'sonnet'))
  })
})

describe('resolveClaudeCliPath', () => {
  // A machine-wide install would win over the fake home below.
  const globalClaude = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some(existsSync)

  async function withHome(run: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'genoffice-claude-home-'))
    try {
      await run(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  it.skipIf(globalClaude)('finds ~/.local/bin/claude under a minimal Finder PATH', async () => {
    await withHome(async (home) => {
      const bin = join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      const executable = join(bin, 'claude')
      await writeFile(executable, '#!/bin/sh\n')
      await chmod(executable, 0o755)
      await expect(
        resolveClaudeCliPath('', {
          platform: 'darwin',
          env: { HOME: home, PATH: '/usr/bin:/bin' },
        }),
      ).resolves.toBe(executable)
    })
  })

  it('honours a configured path that exists and a bare command', async () => {
    await withHome(async (home) => {
      const executable = join(home, 'tools', 'claude')
      await mkdir(join(home, 'tools'))
      await writeFile(executable, '#!/bin/sh\n')
      const options = { platform: 'darwin' as const, env: { HOME: home, PATH: '/usr/bin:/bin' } }
      await expect(resolveClaudeCliPath(executable, options)).resolves.toBe(executable)
      await expect(resolveClaudeCliPath(' claude ', options)).resolves.toBe('claude')
    })
  })

  it.skipIf(globalClaude)('never runs a relative path from an unknown cwd', async () => {
    await withHome(async (home) => {
      const options = { platform: 'darwin' as const, env: { HOME: home, PATH: '/usr/bin:/bin' } }
      for (const relative of ['bin/claude', './claude', 'tools\\claude']) {
        await expect(resolveClaudeCliPath(relative, options)).rejects.toThrow(
          'Claude Code CLI was not found.',
        )
      }
    })
  })

  it.skipIf(globalClaude)('throws the install hint when nothing is found', async () => {
    await withHome(async (home) => {
      await expect(
        resolveClaudeCliPath(join(home, 'gone', 'claude'), {
          platform: 'darwin',
          env: { HOME: home, PATH: '/usr/bin:/bin' },
        }),
      ).rejects.toThrow(
        'Claude Code CLI was not found. Install it and run `claude` once to log in.',
      )
    })
  })
})
