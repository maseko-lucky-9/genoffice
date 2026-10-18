import { describe, expect, it } from 'vitest'
import { requestConfigError } from '../src/providers'
import type { AiProviderConfig } from '../src/types'

const config = (apiKey: string, model: string, extra: Partial<AiProviderConfig> = {}) => ({
  apiKey,
  model,
  ...extra,
})

describe('requestConfigError', () => {
  it('lets the CLI providers through with neither a key nor a model', () => {
    for (const provider of ['claude-code', 'codex'] as const) {
      expect(requestConfigError(provider, config('', ''))).toBeNull()
      expect(requestConfigError(provider, config('', '', { cliPath: '' }))).toBeNull()
      expect(requestConfigError(provider, config('', 'sonnet'))).toBeNull()
    }
  })

  it('lets a keyless custom endpoint through once it names a model', () => {
    const base = { baseUrl: 'http://127.0.0.1:11434/v1' }
    expect(requestConfigError('custom', config('', 'qwen3.5:9b', base))).toBeNull()
    expect(requestConfigError('custom', config('k', 'qwen3.5:9b', base))).toBeNull()
    expect(requestConfigError('custom', config('', '', base))).toBe('no-model')
    expect(requestConfigError('custom', config('k', '', base))).toBe('no-model')
  })

  it('needs both a key and a model for the API-key vendors', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      expect(requestConfigError(provider, config('', 'm'))).toBe('no-key')
      expect(requestConfigError(provider, config('', ''))).toBe('no-key')
      expect(requestConfigError(provider, config('k', ''))).toBe('no-model')
      expect(requestConfigError(provider, config('k', 'm'))).toBeNull()
    }
  })

  it('reports a missing provider config as a missing key, except for the CLI providers', () => {
    expect(requestConfigError('anthropic', undefined)).toBe('no-key')
    expect(requestConfigError('custom', undefined)).toBe('no-key')
    expect(requestConfigError('claude-code', undefined)).toBeNull()
    expect(requestConfigError('codex', undefined)).toBeNull()
  })

  it('needs the key a custom endpoint names in apiKeyEnv once it is resolved', () => {
    const base = { baseUrl: 'https://gw.example.com/v1', profile: { apiKeyEnv: 'GW_KEY' } }
    expect(requestConfigError('custom', config('', 'm', base))).toBe('no-key')
    expect(requestConfigError('custom', config('resolved', 'm', base))).toBeNull()
  })
})
