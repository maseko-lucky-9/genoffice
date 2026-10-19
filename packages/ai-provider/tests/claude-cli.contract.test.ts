import { describe, expect, it } from 'vitest'
import type { AgentToolDef } from '@genoffice/agent-core'
import { runClaudeCli } from '../src/claude-cli'

/**
 * Contract check against the real, logged-in `claude` CLI: catches flag drift
 * the fake-spawn suite cannot see. Opt-in (it spends subscription usage):
 * GENOFFICE_CLAUDE_CONTRACT=1 npx vitest run tests/claude-cli.contract.test.ts
 */
const enabled = process.env.GENOFFICE_CLAUDE_CONTRACT === '1'

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

// what a Finder launch hands the app, plus a key that must never reach the CLI
const finderEnv: NodeJS.ProcessEnv = {
  HOME: process.env.HOME,
  USER: process.env.USER,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  ANTHROPIC_API_KEY: 'invalid-contract-test-key',
}

describe.skipIf(!enabled)('claude CLI contract', () => {
  for (const model of ['', 'haiku']) {
    it(`returns a schema-valid tool call on the subscription (model ${model || 'default'})`, async () => {
      const turn = await runClaudeCli(
        { apiKey: '', model },
        'You edit documents. Paragraph p1 is the title.',
        [{ role: 'user', text: 'Make the title bold.' }],
        tools,
        1024,
        new AbortController().signal,
        { env: finderEnv, timeoutMs: 120_000 },
      )
      const call = turn.toolCalls.find((c) => c.name === 'set_bold')
      expect(call, JSON.stringify(turn)).toBeDefined()
      expect(call!.inputError).toBeUndefined()
      expect(call!.input).toEqual({ paragraphId: 'p1' })
    }, 150_000)
  }
})
