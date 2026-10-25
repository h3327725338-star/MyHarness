# NVIDIA Nemotron on Nebius Token Factory

This page documents one concrete, verified-by-configuration Provider setup: NVIDIA Nemotron models served by [Nebius Token Factory](https://api.tokenfactory.nebius.com/v1/), used as the model backend for a MyHarness coding session.

MyHarness ships an empty built-in Provider catalog (`getBuiltinProviders()` returns `[]`, `MODELS` is `{}`). Nebius is therefore added as a **custom Provider** through the ordinary `openai-completions` path — there is no Nebius-specific code in the repository, and none is required.

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
| `nvidia/Nemotron-3-Ultra-550b-a55b` | Nemotron 3 Ultra | 1,048,576 | 65,536 | text | `supportsReasoningEffort: true` |
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super | 262,144 | 65,536 | text | `supportsReasoningEffort: true` |
| `nvidia/Nemotron-3_5-Lightning` | Nemotron 3.5 Lightning | 1,048,576 | 65,536 | text | `supportsReasoningEffort: true` |
| `nvidia/Nemotron-3.5-Super-VL` | Nemotron 3.5 Super VL | 1,048,576 | not published | text + image (the endpoint also accepts video) | reasoning is on by default; do **not** send `reasoning_effort: none` |

Prices recorded in the example configuration are `$1 / $3` (Ultra), `$0.3 / $0.9` (Super and Super-VL) and `$0.06 / $0.24` (Lightning) per million input/output tokens (USD). They are configuration values, not a live price feed; confirm current pricing on the Token Factory pricing page before budgeting a long session.

The same Provider entry can also carry non-NVIDIA models served by Token Factory (for example `zai-org/GLM-5.3-Flash` for cheap fast turns) as long as at least one NVIDIA open-source model is part of the workflow when the project is used to demonstrate Token Factory usage.

## Setup in the Web UI

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

All three Nemotron entries set `compat.supportsReasoningEffort: true` and map MyHarness thinking levels onto `reasoning_effort`:

| MyHarness level | Sent to Token Factory |
|-----------------|-----------------------|
| `off` | `none` |
| `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | same name |

Because `supportsReasoningEffort` is opt-in, a model entry without it keeps the portable request subset and will not send `reasoning_effort` at all.

## Verifying that a real Token Factory call happened

Check these four things rather than trusting a green UI:

- the composer shows the model you selected (`Nemotron 3 Ultra`, Provider `nebius`);
- the context meter reflects the model's real window (1.0M for Ultra and Lightning, 262K for Super) — MyHarness reads it from the model entry, so a wrong entry shows the wrong number;
- the turn header reports elapsed time and tool-operation count for the finished turn;
- the session JSONL under `~/.myharness/agent/sessions/` records the assistant turns with the model id.

A screenshot of a completed turn in the desktop app, with the model selector visible, is the shortest piece of evidence that the runtime call went to Token Factory and not to another Provider.

## Limitations

- Token Factory availability depends on your Nebius account and country of residence. A `401` means the key is wrong or missing; a `404`/`400` naming the model usually means the model ID is not enabled for your account.
- Nemotron entries here declare `text` input only. Do not attach images and expect them to be read — use `nvidia/Nemotron-3.5-Super-VL` for image input.
- Long-context turns are billed on input tokens; a 1M-window model is not a free upgrade for routine edits.
- MyHarness does not rotate keys or fail over between Token Factory keys. One saved key is used until you change it.

## Related documentation

- [Providers](providers.md) — Provider catalog, credentials and auth precedence.
- [Models and custom Providers](models.md) — `models.json` schema, `compat`, per-model overrides.
- [Settings](settings.md) — where global and project settings live.
- [Web Search](web-search.md) — optional Tavily-backed search used alongside the model.
