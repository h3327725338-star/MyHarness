# NVIDIA Nemotron on Nebius Token Factory

This page documents one concrete, verified-by-configuration Provider setup: NVIDIA Nemotron models and DeepSeek V4.1 Flash 1017 served by [Nebius Token Factory](https://api.tokenfactory.nebius.com/v1/), used as the model backend for a MyHarness coding session.

The `@myharness/ai` catalog stays empty (`getBuiltinProviders()` returns `[]`, `MODELS` is `{}`). Nebius Token Factory is offered ready-made by the Coding Agent product layer instead: a preset (`src/providers/models/nebius-preset.ts`) that is written into `models.json` as an ordinary `openai-completions` Provider once the user pastes a key (`src/application/use-cases/nebius-setup.ts`). After that it is a custom Provider like any other: it can be edited or deleted, and requests use no Nebius-specific code.

## Why this page exists

A MyHarness session is only as real as the Provider it runs on. This page records the exact endpoint, API type, model IDs, context windows and reasoning settings used, so that the configuration can be reproduced instead of guessed.

## Provider settings

| Field | Value |
|-------|-------|
| Provider id | `nebius` |
| Base URL | `https://api.tokenfactory.nebius.com/v1/` |
| API type | `openai-completions` |
| Auth | API key from Token Factory (`authMode: "apiKey"`) |
| Transport | standard HTTP; `keepAliveSeconds` and `ipFamily` keep their defaults |
| Streaming | enabled (Chat Completions SSE) |

Token Factory exposes an OpenAI-compatible Chat Completions surface, so the portable request subset applies: MyHarness sends the `system` role and `max_tokens`, and omits OpenAI-only fields unless a model opts into them with `compat`.

## Models used

| Model ID | Display name | Context | Max output | Input | Reasoning |
|----------|--------------|---------|------------|-------|-----------|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | DeepSeek V4.1 Flash 1017 | 1,048,576 | not published (65,536 is set) | text + image | off / low / high / max, as `reasoning_effort` |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | Nemotron 3 Ultra | 1,048,576 | 65,536 | text | off / medium / high, as `reasoning_effort` |
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super | 262,144 | 65,536 | text | off / low / high, as `reasoning_effort` |
| `nvidia/Nemotron-3_5-Lightning` | Nemotron 3.5 Lightning | 1,048,576 | 65,536 | text | off / high, as `reasoning_effort` |
| `nvidia/Nemotron-3.5-Super-VL` | Nemotron 3.5 Super VL | 1,048,576 | not published | text + image (the endpoint also accepts video) | always on; do **not** send `reasoning_effort: none` |

Prices recorded in the built-in setup and the example configuration are `$0.3 / $0.006 / $1.2` (DeepSeek V4.1 Flash 1017), `$1 / $0.12 / $3` (Ultra), `$0.3 / $0.06 / $0.9` (Super and Super-VL) and `$0.06 / $0.03 / $0.24` (Lightning) per million input/cached input/output tokens (USD), as Token Factory's public endpoints page listed them on 2026-10-30. They are configuration values, not a live price feed; confirm current pricing on the Token Factory pricing page before budgeting a long session.

The same Provider entry can also carry non-NVIDIA models served by Token Factory (for example `zai-org/GLM-5.3-Flash` for cheap fast turns) as long as at least one NVIDIA open-source model is part of the workflow when the project is used to demonstrate Token Factory usage.

## Built-in setup (one key)

1. Open `/settings` → **Providers**. **Nebius Token Factory** is always first in the list ("Built in · NVIDIA Nemotron"); an empty list opens on it, and the welcome screen's "No model is available yet" link leads there.
2. Click **Get an API key**. Settings closes and `https://tokenfactory.nebius.com/project/api-keys` opens in a website tab of the built-in browser (the system browser when there is no built-in browser or links are set to open there). Sign in and create a key.
3. Paste the key into the strip above that page and click **Save key** (or paste it into the card in Settings and click **Save and set up**).

What happens on save (`POST /api/providers/nebius/setup`):

- The key is checked with the account's model list (`GET /v1/models`, free). A `401`/`403` stops here and nothing is written.
- The models the list names are added under the spelling the list uses: DeepSeek V4.1 Flash 1017 (only the 1017 build; a plain "DeepSeek V4.1 Flash" is not matched), Nemotron 3 Ultra, Nemotron 3.5 Lightning and Nemotron 3.5 Super VL. If the list cannot be read, only the four IDs checked by hand are added (DeepSeek on the Token Factory model page on 2026-10-29, the three Nemotron models by request on 2026-10-25). Nemotron 3 Nano is no longer added: its jobs went to Ultra on 2026-10-29. A Nano entry an earlier version added stays in `models.json`. An existing `nebius` entry keeps its own Base URL, models and edits; only missing models are appended.
- The key goes to the credential store (`auth.json`), not `models.json`.
- Every job that has no model of its own gets one; a job with its own model keeps it:

| Model | Jobs |
|-------|------|
| DeepSeek V4.1 Flash 1017 | main model (only when there is no usable main model yet), commit descriptions |
| Nemotron 3 Ultra | sub-agents, conversation naming, translation |
| Nemotron 3.5 Lightning | compaction, fallback model, Auto Memory, hand-off notes, bookmark notes, scheduled tasks, worktree naming, branch summaries |
| Nemotron 3.5 Super VL | vision assistant |

- A model the account does not list hands its jobs on: DeepSeek's to Ultra (Lightning when Ultra is missing too), Ultra's to Lightning. Super VL has no stand-in.
- The main chat is on DeepSeek V4.1 Flash because the Nemotron models had problems calling tools as the main agent in testing; Nemotron keeps the sub-agent, naming, translation, background and image work.
- The main model (when it is set up now), sub-agents and commit descriptions get their model's highest thinking level (max for DeepSeek, high for Ultra); the other jobs are left at Default, which also runs a job at its model's highest level (high for Ultra and Lightning; Super VL always reasons).
- Conversation naming, the vision assistant, sub-agents and the fallback model are turned on when the user never touched them; one the user turned off stays off.

Nano (added by versions before 2026-10-29) is declared without `compat.supportsReasoningEffort` (like Super VL), so MyHarness never sends `reasoning_effort` to it and it always reasons; its 16,384-token output cap is a conservative value, since Token Factory does not publish one.

**Balance and spending.** Token Factory has no balance API (the balance and **Top up** are in the console's navigation). Once set up, the Nebius card shows **Balance and top up** (opens `https://tokenfactory.nebius.com/`), **Get an API key**, and this computer's estimate: every finished model request adds `usage.cost.total` to `provider-spend.json` next to `models.json` (prices from the model entries; the Token Factory bill is what counts). A request refused with HTTP `402`, or with an error that names the balance, is explained as a balance problem. The exact error Token Factory returns for a negative balance has not been observed.

## Setup in the Web UI by hand

1. Start MyHarness (`.\dev-desktop.cmd`, or the Web entry described in the root README).
2. Open `/settings` → **Providers** → **添加 Provider** → **创建自定义 Provider**.
3. Choose **OpenAI Chat Completions**.
4. Set Base URL to `https://api.tokenfactory.nebius.com/v1/` and the Provider id to `nebius`.
5. Add the model IDs you need from the table above — the three text models first, and `nvidia/Nemotron-3.5-Super-VL` if the workflow needs image input. Mark the text models as reasoning-capable and declare `text` input; declare `text` + `image` for Super-VL and leave its reasoning field at the default.
6. Save, then paste the Token Factory API key when the Provider asks for credentials. The key is stored in `~/.myharness/agent/auth.json` under the `nebius` entry.
7. Run the built-in connection test, then pick a model in `/model` and start a session.

## Setup by editing models.json

Copy the ready-made example [`examples/nebius-models.json`](examples/nebius-models.json) into `~/.myharness/agent/models.json`, or merge its `providers.nebius` block into an existing file. The example reads the key from the `NEBIUS_TOKEN_FACTORY_API_KEY` environment variable so that no secret is written to disk:

```json
{
  "providers": {
    "nebius": {
      "baseUrl": "https://api.tokenfactory.nebius.com/v1/",
      "api": "openai-completions",
      "apiKey": "$NEBIUS_TOKEN_FACTORY_API_KEY",
      "models": [
        { "id": "nvidia/Nemotron-3-Ultra-550b-a55b" }
      ]
    }
  }
}
```

Saving `models.json` from `/settings` reloads it; opening `/model` does not re-read the file. See [models.md](models.md) for value resolution (`$ENV`, `!command`, literals) and per-model overrides.

## Vision input

`nvidia/Nemotron-3.5-Super-VL` is the multimodal entry: 120B total parameters with 12B active, a C-RADIO vision encoder, and text, image and video input. The Provider does not need a separate vision endpoint — the same chat message carries `image_url` parts.

Verified against Token Factory on 2026-10-25 with a generated 420×160 PNG (a random string plus a red circle and a blue rectangle):

- `HTTP 200` in ~1.3 s; the model read the random string and both shapes correctly.
- `max_tokens: 200` returned `finish_reason: length` with `content: null` and 200 reasoning tokens — the whole budget went into reasoning before any answer text. Use a few thousand output tokens for this model, not a few hundred.
- `reasoning_effort: "none"` is worse than omitting the parameter: reasoning tokens drop to 0 but the thinking text leaks into `content` and is duplicated at the end. Leave the field out and let the model reason.

Because of the second and third points, the example configuration declares this model with `reasoning: true` and **without** `compat.supportsReasoningEffort`: MyHarness then never sends `reasoning_effort`, which is the only behaviour verified to produce clean answers. MyHarness model entries also only accept `text` and `image` in `input`, so the video capability is used through the raw API rather than declared in `models.json`.

## Reasoning levels

Token Factory's Chat Completions API accepts `reasoning_effort` values `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max` for every model, but a model runs only its own reasoning modes. MyHarness offers each model only the modes NVIDIA's model card documents for it (`enable_thinking`, plus `medium_effort` or `low_effort` in the chat template) and hides the other levels with `null` in `thinkingLevelMap`:

| Model | Modes in the model's documentation | MyHarness levels → `reasoning_effort` |
|-------|------------------------------|---------------------------------------|
| DeepSeek V4.1 Flash 1017 | DeepSeek's own API: `low`, `high` (default) and `max` | `off` → `none`, `low` → `low`, `high` → `high`, `max` → `max` |
| Nemotron 3 Ultra | reasoning off, medium effort, full reasoning | `off` → `none`, `medium` → `medium`, `high` → `high` |
| Nemotron 3 Super (example file only) | reasoning off, low effort, full reasoning | `off` → `none`, `low` → `low`, `high` → `high` |
| Nemotron 3.5 Lightning | reasoning on or off | `off` → `none`, `high` → `high` |
| Nemotron 3.5 Super VL, Nemotron 3 Nano | (no `reasoning_effort` is sent) | `high` only: the model's default, reasoning on |

What Token Factory runs for each name is not documented by Nebius. For DeepSeek V4.1 Flash 1017 the levels follow DeepSeek's own API. The maintainer ran it through Token Factory with a real key on a second PC (October 2026): its tool calls and switching between its thinking levels worked; how far each level changes the amount of reasoning was not measured. A third-party measurement on Super found `none` answers without reasoning, `low` reasons less than `medium`, and `high` reasons as long as `medium`, which matches Super's three modes. That Ultra's `medium` runs its medium-effort mode has not been measured.

MyHarness 0.0.3 wrote every accepted name as a level of its own for Ultra and Lightning, and no map for Super VL and Nano. Such entries, exactly as that version wrote them, get the levels above when `models.json` is read (`upgradeNebiusPresetModels`); an entry the user changed is left alone.

Because `supportsReasoningEffort` is opt-in, a model entry without it keeps the portable request subset and will not send `reasoning_effort` at all.

## Verifying that a real Token Factory call happened

Check these four things rather than trusting a green UI:

- the composer shows the model you selected (for example `DeepSeek V4.1 Flash 1017` or `Nemotron 3 Ultra`, Provider `nebius`);
- the context meter reflects the model's real window (1.0M for DeepSeek, Ultra and Lightning, 262K for Super) — MyHarness reads it from the model entry, so a wrong entry shows the wrong number;
- the turn header reports elapsed time and tool-operation count for the finished turn;
- the session JSONL under `~/.myharness/agent/sessions/` records the assistant turns with the model id.

A screenshot of a completed turn in the desktop app, with the model selector visible, is the shortest piece of evidence that the runtime call went to Token Factory and not to another Provider.

## Limitations

- Token Factory availability depends on your Nebius account and country of residence. A `401` means the key is wrong or missing; a `404`/`400` naming the model usually means the model ID is not enabled for your account.
- Nemotron text entries here declare `text` input only. Do not attach images and expect them to be read — use `nvidia/Nemotron-3.5-Super-VL` for image input. DeepSeek V4.1 Flash 1017 declares `text` + `image`, but with the vision assistant on (the default once it has a model) images go to Super VL and the main model gets its report.
- Long-context turns are billed on input tokens; a 1M-window model is not a free upgrade for routine edits.
- MyHarness does not rotate keys or fail over between Token Factory keys. One saved key is used until you change it.

## Related documentation

- [Providers](providers.md) — Provider catalog, credentials and auth precedence.
- [Models and custom Providers](models.md) — `models.json` schema, `compat`, per-model overrides.
- [Settings](settings.md) — where global and project settings live.
- [Web Search](web-search.md) — optional Tavily-backed search used alongside the model.
