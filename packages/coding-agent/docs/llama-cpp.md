# llama.cpp

> **状态说明（2026-08）**：MyHarness 没有内置的 llama.cpp router 支持。源码中不存在 `LLAMA_BASE_URL`/`LLAMA_API_KEY` 环境变量处理，也没有 `/login`、`/llama` 命令。接入方式是把它当作自定义 Provider（`models.json` 或 `pi.registerProvider`），下文描述这条路，另见 [providers.md](providers.md#llamacpp) 和 [extensions.md](extensions.md)。

MyHarness reaches the [llama.cpp](https://github.com/ggml-org/llama.cpp) router server through a custom Provider. The router discovers multiple GGUF models and loads or unloads them on demand.

Use a current llama.cpp build with router support. Follow the [build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) or install a [prebuilt release](https://github.com/ggml-org/llama.cpp/releases) for your platform.

## Start the router

Start `llama-server` without `--model` or `-m`. Passing a model starts single-model mode instead of router mode.

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

Important options:

- `--models-dir ~/models` discovers local GGUF files.
- `--no-models-autoload` keeps loading explicit.
- `--jinja` enables compatible chat templates and tool calling.
- `-ngl 999` offloads as many layers as possible to the GPU.
- `-c 32768` sets the context window for each loaded model. Omit it to use the model's native context, which may require substantially more memory.

A single-file model can sit directly in the model directory. Put multimodal and multi-shard models in separate subdirectories:

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

Restart the router after manually adding files. For per-model context sizes and other options, use [llama.cpp model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets).

## Configure MyHarness

Configure the provider as a custom Provider: point a `models.json` entry (or
`pi.registerProvider`) at the router's OpenAI-compatible endpoint and pass the
API key as that Provider's credential. MyHarness does not read
`LLAMA_BASE_URL` / `LLAMA_API_KEY` environment variables. See
[providers.md](providers.md#llamacpp).

If the server uses an API key, start `llama-server` with the matching `--api-key` value. Keep `--host 127.0.0.1` for local-only access.

## Manage models

Only loaded models appear in `/model`. Model management (load, unload, download) is handled through the llama.cpp router API.

Downloads run inside the llama.cpp process, so a gated Hugging Face repository
needs `HF_TOKEN` in that process; MyHarness itself does not read it.

## Troubleshooting

Check that the router is reachable:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **No models visible:** Check `--models-dir`, the directory layout, and restart the router.
- **Model missing from `/model`:** Ensure it is loaded in the router first.
- **Load fails or uses too much memory:** Lower `-c` or unload another model.
- **Server is not in router mode:** Start it without `--model`, `-m`, or `-hf`.
