# OpenCode tiered model router

An OpenCode plugin that judges each new human prompt with Qwen and routes the
entire agent turn to the least capable configured model tier. Tool-loop
continuations remain on the selected model without another judge request.

The defaults are:

- `model-router/auto` as the trigger model
- `easy` → `qwen/Qwen3.6-Sonar`
- `complex` → `portkey/gpt-5.6-sol`, variant `high`
- judge errors, timeouts, and invalid responses → `complex`

## OpenCode configuration

Reference the plugin from `opencode.json` and define its three providers. The
Portkey provider intentionally uses `@ai-sdk/openai` and an environment-backed
credential.

```json
{
  "plugin": [
    ["file:///absolute/path/to/opencode-model-router/src/index.ts", {}]
  ],
  "provider": {
    "model-router": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:1/v1", "apiKey": "unused" },
      "models": { "auto": { "name": "Automatic tier" } }
    },
    "qwen": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://llm-eval-lb-dev.aws-dev.sonarsource.com/qwen-sonar/v1",
        "apiKey": "unused"
      },
      "models": { "Qwen3.6-Sonar": { "name": "Qwen3.6-Sonar" } }
    },
    "portkey": {
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "https://api.portkey.ai/v1",
        "apiKey": "{env:PORTKEY_OPENAI_API_KEY}"
      },
      "models": {
        "gpt-5.6-sol": {
          "name": "gpt-5.6-sol",
          "reasoning": true,
          "variants": { "high": { "reasoningEffort": "high" } }
        }
      }
    }
  }
}
```

Select `model-router/auto` to route a turn. Selecting any other model manually
bypasses the plugin.

Each routed turn writes `judge request`, `judge response`, and either the
selected tier or fallback error to OpenCode's log under the
`opencode-model-router` service. Request logs contain the user's bounded prompt
text, but never request headers or environment-backed credentials.

Set `diagnostics.echo` to `true` in the plugin options for concise terminal
summaries. Interactive OpenCode displays native toasts; `opencode run` prints
one-line messages to stderr. Full requests and raw responses remain in the log.

Plugin options accept a custom judge, trigger, tier list, and fallback:

```ts
type RouterOptions = {
  judge?: { baseURL?: string; model?: string; timeoutMs?: number }
  trigger?: { providerID: string; modelID: string; variant?: string }
  tiers?: Array<{
    id: string
    description: string
    target: { providerID: string; modelID: string; variant?: string }
  }>
  fallbackTier?: string
}
```

Tier IDs, descriptions, targets, trigger, timeout, and fallback references are
validated when OpenCode loads the plugin. The judge prompt and strict response
schema are generated from the configured tier list.

## Verification

```bash
bun install
bun run typecheck
bun test
```

The opt-in live test needs internal-network access, OpenCode 1.18.16 or newer,
and `PORTKEY_OPENAI_API_KEY`. It creates isolated XDG config/data directories,
uses the read-only `plan` agent, and retains sanitized diagnostics under
`artifacts/`.

```bash
RUN_LIVE_E2E=1 bun run e2e
```

Phase 1 deliberately does not retry Qwen worker failures or recover silent
worker hangs beyond the nine-second judge timeout.
