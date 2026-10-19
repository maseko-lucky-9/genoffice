import type {
  AiSearchProviderId,
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
} from './types'

export const AI_SEARCH_PROVIDERS: AiSearchProviderMeta[] = [
  { id: 'serper', label: 'Serper', keyPlaceholder: 'Serper API key', imageSearch: true },
  { id: 'serply', label: 'Serply', keyPlaceholder: 'Serply API key', imageSearch: true },
  { id: 'tavily', label: 'Tavily', keyPlaceholder: 'tvly-...', imageSearch: false },
  { id: 'parallel', label: 'Parallel', keyPlaceholder: 'Parallel API key', imageSearch: false },
  // exa/firecrawl: AI-search APIs without an image endpoint (like Tavily/Parallel)
  { id: 'exa', label: 'Exa', keyPlaceholder: 'Exa API key', imageSearch: false },
  { id: 'firecrawl', label: 'Firecrawl', keyPlaceholder: 'fc-...', imageSearch: false },
]

export function defaultAiSearchSettings(): AiSearchSettings {
  // no provider chosen: the default chain runs (env keys, free Parallel, DuckDuckGo)
  return {
    providers: {
      serper: { apiKey: '' },
      serply: { apiKey: '' },
      tavily: { apiKey: '' },
      parallel: { apiKey: '' },
      exa: { apiKey: '' },
      firecrawl: { apiKey: '' },
    },
  }
}

export function resolveAiSearchSettings(
  stored: Partial<AiSearchSettings> | undefined,
): AiSearchSettings {
  const defaults = defaultAiSearchSettings()
  if (!stored) return defaults
  const providers = { ...defaults.providers }
  for (const id of ['serper', 'serply', 'tavily', 'parallel', 'exa', 'firecrawl'] as const) {
    const key = stored.providers?.[id]?.apiKey
    if (typeof key === 'string') providers[id] = { apiKey: key.trim() }
  }
  // a pre-fork 'genspark' (or any id this build does not ship) reads as not chosen
  const provider = AI_SEARCH_PROVIDERS.some((m) => m.id === stored.provider)
    ? stored.provider
    : undefined
  return provider ? { provider, providers } : { providers }
}

/**
 * The chosen search provider when it can run: Parallel even without a key (its
 * free Search MCP), any other only with one. Null means the default chain
 * (env keys, then free Parallel, then DuckDuckGo).
 */
export function activeSearchProvider(
  settings: Pick<AiSettings, 'search'>,
): AiSearchProviderId | null {
  const provider = settings.search?.provider
  if (!provider || !AI_SEARCH_PROVIDERS.some((m) => m.id === provider)) return null
  if (provider === 'parallel') return 'parallel'
  // Trim-aware: a whitespace-only key from in-memory settings falls back
  // instead of sending `Bearer    ` to the search backend.
  return settings.search?.providers?.[provider]?.apiKey?.trim() ? provider : null
}
