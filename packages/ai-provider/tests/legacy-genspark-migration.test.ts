import { describe, expect, it } from 'vitest'
import { sanitizeAiSettings } from '../src/ai-settings-guard'
import { defaultAiMediaSettings } from '../src/media'
import { activeProvider, defaultAiSettings, resolveAiSettings } from '../src/providers'
import { defaultAiSearchSettings } from '../src/search-settings'
import type { AiSettings } from '../src/types'

/** the shape an upstream build left in ai-settings.json while signed in to Genspark */
function legacyGensparkFile(): Record<string, unknown> {
  return {
    provider: 'genspark',
    gskToolsEnabled: true,
    search: {
      provider: 'genspark',
      providers: { serper: { apiKey: '' }, tavily: { apiKey: '' } },
    },
    media: {
      imageProvider: 'genspark',
      analysisProvider: 'genspark',
      videoAnalysisProvider: 'genspark',
      providers: { genspark: { apiKey: '', imageModel: '', analysisModel: '' } },
    },
    providers: {
      genspark: { apiKey: '', model: 'claude-opus-5-5' },
      anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' },
    },
  }
}

describe('legacy Genspark settings migration', () => {
  it('defaults a fresh install to Claude Code', () => {
    expect(defaultAiSettings().provider).toBe('claude-code')
    expect(defaultAiSettings()).not.toHaveProperty('gskToolsEnabled')
  })

  it('turns a stored genspark selection into claude-code with non-genspark defaults', () => {
    const resolved = resolveAiSettings(legacyGensparkFile(), defaultAiSettings())
    expect(resolved.provider).toBe('claude-code')
    expect(resolved).not.toHaveProperty('gskToolsEnabled')
    expect(resolved.providers).not.toHaveProperty('genspark')
    // the user's other provider configs survive the migration
    expect(resolved.providers.anthropic).toEqual({ apiKey: 'sk-ant', model: 'claude-sonnet-4-6' })

    const media = defaultAiMediaSettings()
    expect(resolved.media!.imageProvider).toBe(media.imageProvider)
    expect(resolved.media!.analysisProvider).toBe(media.analysisProvider)
    expect(resolved.media!.videoAnalysisProvider).toBe(media.videoAnalysisProvider)
    expect(resolved.media!.providers).not.toHaveProperty('genspark')
    expect(resolved.search!.provider).toBe(defaultAiSearchSettings().provider)
    for (const id of [
      resolved.media!.imageProvider,
      resolved.media!.analysisProvider,
      resolved.media!.videoAnalysisProvider,
      resolved.search!.provider,
    ]) {
      expect(id).not.toBe('genspark')
    }
  })

  it('maps the pre-catalog media provider field away from genspark too', () => {
    const resolved = resolveAiSettings(
      { ...legacyGensparkFile(), media: { provider: 'genspark' } },
      defaultAiSettings(),
    )
    expect(resolved.media!.imageProvider).toBe(defaultAiMediaSettings().imageProvider)
    expect(resolved.media!.analysisProvider).toBe(defaultAiMediaSettings().analysisProvider)
  })

  it('maps any unknown provider id to claude-code', () => {
    const resolved = resolveAiSettings(
      { provider: 'no-such-vendor', providers: {} },
      defaultAiSettings(),
    )
    expect(resolved.provider).toBe('claude-code')
  })

  it('falls back to claude-code when the stored provider is not usable', () => {
    const settings = defaultAiSettings()
    settings.provider = 'anthropic'
    expect(activeProvider(settings)).toBe('claude-code')
    expect(activeProvider({ ...settings, provider: 'genspark' } as unknown as AiSettings)).toBe(
      'claude-code',
    )
  })

  it('sanitizeAiSettings accepts a legacy genspark payload and maps it to claude-code', () => {
    const sanitized = sanitizeAiSettings(legacyGensparkFile())
    expect(sanitized).not.toBeNull()
    expect(sanitized!.provider).toBe('claude-code')
    expect(sanitized).not.toHaveProperty('gskToolsEnabled')
    expect(sanitized!.providers).not.toHaveProperty('genspark')
    expect(sanitized!.providers.anthropic!.apiKey).toBe('sk-ant')
  })
})
