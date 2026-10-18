/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_PROVIDERS, defaultAiSettings } from '@genoffice/ai-provider'
import type { AiSettings } from '@genoffice/ai-provider'
import type { HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

/**
 * Claude Code rides the subscription login of the local `claude` CLI: the pane
 * must not ask for an API key or a base URL, and none of the Codex-only
 * behaviour (CLI path field, Codex hint, live Codex model refresh) may leak in.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let getCodexModels: ReturnType<typeof vi.fn>
let testAiSettings: ReturnType<typeof vi.fn>

beforeEach(() => {
  getCodexModels = vi.fn(async () => ({ models: ['gpt-5.6-terra'], defaultModel: 'gpt-5.6-terra' }))
  testAiSettings = vi.fn(async () => ({ ok: true }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function installApi(settings: AiSettings): void {
  window.aiOffice = {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAnalyticsEnabled: async () => true,
    setAnalyticsEnabled: async () => true,
    getAiPanelPrefs: async () => ({ fontSize: 'medium', customFontSize: 14, spellcheck: true }),
    setAiPanelPrefs: async (patch: unknown) => patch,
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    githubStars: async () => null,
    // the shipped catalog, as the preload hands it over
    getAiProviders: () => AI_PROVIDERS.map((meta) => ({ ...meta, defaultBaseUrl: '' })),
    getAiSettings: async () => settings,
    setAiSettings: vi.fn(async () => undefined),
    getCodexModels,
    testAiSettings,
  } as unknown as HomeApi
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

async function openAiPane(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(SettingsModal, {
          status: null,
          loggingOut: false,
          loginWaiting: false,
          loginUrl: null,
          urlCopied: false,
          onOpenLoginUrl: vi.fn(),
          onCopyLoginUrl: vi.fn(),
          onClose: vi.fn(),
          onLogin: vi.fn(),
          onLogout: vi.fn(),
        }),
      ),
    )
    await Promise.resolve()
  })
  const nav = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find((button) =>
    button.textContent?.includes('AI Model'),
  )
  await click(nav!)
}

function picker(label: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(`.gs-dd-btn[aria-label="${label}"]`)
}

async function pickProvider(label: string): Promise<void> {
  await click(picker('Provider')!)
  const option = Array.from(
    host.querySelectorAll<HTMLButtonElement>('.gs-dd-pop [role="option"]'),
  ).find((button) => button.textContent === label)
  await click(option!)
}

function aiPane(): HTMLElement {
  return host.querySelector<HTMLElement>('.set-pane-ai-model')!
}

describe('Claude Code in the AI model pane', () => {
  it('asks for no key and shows none of the Codex controls', async () => {
    const settings = defaultAiSettings()
    settings.provider = 'anthropic'
    settings.providers.anthropic = { apiKey: 'k', model: 'claude-sonnet-5' }
    installApi(settings)
    await openAiPane()
    expect(host.querySelector('#set-ai-key')).not.toBeNull()

    await pickProvider('Claude Code')

    expect(picker('Provider')!.textContent).toContain('Claude Code')
    expect(host.querySelector('#set-ai-key')).toBeNull()
    expect(host.querySelector('#set-ai-base-url')).toBeNull()
    expect(host.querySelector('#set-ai-cli-path')).toBeNull()
    expect(aiPane().textContent).not.toMatch(/codex/i)
    expect(aiPane().textContent).not.toContain('Chats use your own key')
    expect(picker('Model')!.textContent).toBe('sonnet')
  })

  it('tests the connection without refreshing the Codex model list', async () => {
    const settings = defaultAiSettings()
    settings.provider = 'claude-code'
    installApi(settings)
    await openAiPane()
    // the pane loads the Codex catalog once on open, whatever is selected
    const callsOnOpen = getCodexModels.mock.calls.length

    const test = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Test connection',
    )!
    await click(test)
    await act(async () => {
      await Promise.resolve()
    })

    expect(testAiSettings).toHaveBeenCalledTimes(1)
    expect((testAiSettings.mock.calls[0]![0] as AiSettings).provider).toBe('claude-code')
    expect(host.textContent).toContain('Connection OK')
    expect(getCodexModels).toHaveBeenCalledTimes(callsOnOpen)
  })
})
