# ADR 001: Local AI (Claude Code subscription + Ollama), with no Genspark sign-in

- **Status:** accepted (2026-10-18)
- **Scope:** this fork only (`maseko-lucky-9/genoffice`). Upstream imports external PRs into a private tree, so nothing here goes back to upstream.

## Context

Upstream defaults the AI to "Sign in with Genspark". That flow mints a `gsk` key and sends every model call through Genspark's proxy. Bring-your-own-key providers exist, but two gaps remain:

- None of them can use a Claude subscription.
- The main-process guards reject keyless endpoints, so local Ollama fails with "No API key configured".

## Decision

1. **Add a `claude-code` provider.** It spawns the locally installed Claude Code CLI (`claude -p`), which runs on the user's own subscription login.
   - It reuses the Codex CLI pattern: a structured-JSON turn, with GenOffice executing the document tools itself.
   - Flags:
     - `--safe-mode` keeps the user's CLAUDE.md, hooks, plugins and MCP out of the document agent.
     - `--tools ''` disables the built-in tools.
     - `--json-schema` forces the `{text, toolCalls}` shape.
     - `--no-session-persistence`.
   - The child process gets an allowlisted environment. An inherited `ANTHROPIC_API_KEY` or `CLAUDECODE` would otherwise switch billing to the API or change the CLI's behaviour.
   - `--bare` is never used, because it disables OAuth.
2. **Apply one keyless rule in every app.** CLI providers need neither a key nor a model. Custom OpenAI-compatible endpoints such as Ollama need a base URL and a model, but no key.
3. **Delete every piece of Genspark code:**
   - the login flow, the `gsk` key resolution, the `genspark` provider and its proxy URLs;
   - the cloud tools, cloud projects, Slides cloud generation, credits and account UI;
   - the bundled `@genspark/cli`.

   `claude-code` becomes the default provider, and stored `genspark` settings migrate to it.

## Evidence (spikes, 2026-10-18, `claude` 2.1.302, Finder-like `env -i` PATH)

- **Structured output:** `structured_output` came back schema-valid with `--tools ''` in about 3.5 s per spawn.
- **Auth:** `apiKeySource: "none"`, meaning subscription OAuth.
- **Isolation:** with `--safe-mode` there were 0 hook events and no CLAUDE.md in context. Without it, 22 hook events fired and the global CLAUDE.md was loaded.
- **Not logged in:** exit code 1 with `is_error: true` and the message "Not logged in · Please run /login". `subtype` still reads "success", so callers must check `is_error`.
- **Ollama:** `/v1/chat/completions` returned well-formed `tool_calls` for `qwen3.5:9b`, which loaded with a 65,536-token context.

## Consequences

- The provider runs one stateless spawn per tool round, resending the full context each time.
  - There is no token streaming and no vision.
  - Upgrade path: a persistent `--input-format stream-json` session per conversation.
- Removing Genspark means permanent merge conflicts in these areas when pulling upstream. Expect to resolve them by hand on every sync.
- Apache-2.0 attribution (LICENSE, NOTICE and the trademark line) is kept.
