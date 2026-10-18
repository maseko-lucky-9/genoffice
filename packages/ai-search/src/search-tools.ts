/**
 * ai:web-search / ai:image-search for the editors' main processes: reads
 * ai-settings.json live and turns the search provider choice into
 * SearchOptions — a chosen provider that can run goes first; otherwise the
 * default chain runs (env keys, then the free Parallel MCP, then DuckDuckGo).
 */

import {
  activeSearchProvider,
  type AiSearchProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import { imageSearch, webSearch, type SearchOptions } from './index'
import { readAiSettingsFile } from './media-tools'

export function searchOptionsFromSettings(settings: AiSettings): SearchOptions {
  const provider = activeSearchProvider(settings)
  // nothing chosen (or a keyed provider without its key): the default chain, where
  // the *_API_KEY env vars keep their precedence
  if (provider === null) return {}
  const key = settings.search?.providers?.[provider]?.apiKey?.trim() ?? ''
  // a chosen Parallel with a blank key stays keyless even when PARALLEL_API_KEY is set
  if (provider === 'parallel') return { parallelKey: key, prefer: 'parallel' }
  if (provider === 'serply') return { serplyKey: key, prefer: 'serply' }
  if (provider === 'exa') return { exaKey: key, prefer: 'exa' }
  if (provider === 'firecrawl') return { firecrawlKey: key, prefer: 'firecrawl' }
  return provider === 'tavily' ? { tavilyKey: key, prefer: 'tavily' } : { serperKey: key }
}

export function webSearchTool(settingsPath: string, query: string, maxResults = 6) {
  return webSearch(query, maxResults, searchOptionsFromSettings(readAiSettingsFile(settingsPath)))
}

export function imageSearchTool(settingsPath: string, query: string, maxResults = 8) {
  return imageSearch(query, maxResults, searchOptionsFromSettings(readAiSettingsFile(settingsPath)))
}

/** settings-UI test: the selected backend (keyed or free) must answer one minimal query. */
export async function testSearchProvider(
  provider: AiSearchProviderId,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  apiKey = apiKey.trim()
  if (!apiKey && provider !== 'parallel') return { ok: false, error: 'API key is empty' }
  const options: SearchOptions = {
    serperKey: provider === 'serper' ? apiKey : '',
    serplyKey: provider === 'serply' ? apiKey : '',
    tavilyKey: provider === 'tavily' ? apiKey : '',
    parallelKey: provider === 'parallel' ? apiKey : '',
    exaKey: provider === 'exa' ? apiKey : '',
    firecrawlKey: provider === 'firecrawl' ? apiKey : '',
    prefer: provider,
  }
  const r = await webSearch('GenOffice', 1, options)
  if (r.method === provider) return { ok: true }
  return {
    ok: false,
    error:
      r.method === 'error'
        ? (r.error ?? 'search failed')
        : `${provider} did not answer (service unavailable, key rejected or quota exhausted); fell back to ${r.method}`,
  }
}
