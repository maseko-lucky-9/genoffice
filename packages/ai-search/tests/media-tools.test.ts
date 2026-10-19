import { describe, expect, it } from 'vitest'
import {
  NO_ANALYSIS_PROVIDER_ERROR,
  NO_IMAGE_PROVIDER_ERROR,
  analyzeMediaTool,
  generateImageTool,
} from '../src/media-tools'

// nonexistent settings file → defaults: no media provider has a key
const SETTINGS = '/nonexistent/ai-settings.json'

describe('media tools without a configured provider', () => {
  it('generate_image answers with a settings hint instead of throwing', async () => {
    const r = await generateImageTool(SETTINGS, {
      prompt: 'red podcast icon',
      transparentBackground: true,
    })
    expect(r).toEqual({ error: NO_IMAGE_PROVIDER_ERROR })
  })

  it('analyze_media answers with a settings hint instead of throwing', async () => {
    const r = await analyzeMediaTool(SETTINGS, {
      mediaUrls: ['https://cdn/x/0.png'],
      requirements: 'describe this',
    })
    expect(r).toEqual({ error: NO_ANALYSIS_PROVIDER_ERROR })
  })

  it('still validates the arguments first', async () => {
    expect(await generateImageTool(SETTINGS, { prompt: '  ' })).toEqual({
      error: 'prompt must not be empty',
    })
    expect(await analyzeMediaTool(SETTINGS, { mediaUrls: [], requirements: 'x' })).toEqual({
      error: 'mediaUrls must not be empty',
    })
  })
})
