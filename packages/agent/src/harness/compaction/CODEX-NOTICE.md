# Codex compaction attribution and adaptation

OpenAI Codex — Copyright 2025 OpenAI.
Licensed under Apache-2.0; see CODEX-LICENSE in this directory.

The TypeScript compaction implementation is adapted from the actual Rust source at
https://github.com/openai/codex/commit/4701aa4b4239c70063ab6f2fcb835324f9c109f4
(the upstream HEAD resolved when this work began).

Sources: `codex-rs/core/src/compact.rs`, `compact_remote_v2.rs`,
`compact_remote_history.rs`, `context_manager/history.rs`, `session/turn.rs`,
`codex-rs/utils/string/src/truncate.rs`, and the compaction prompt templates.
The code has been modified to use MyHarness messages, streaming providers, session
storage and cancellation. It does not run the Rust Codex runtime.

Local checkpoints retain up to 20,000 approximate tokens of real user text and
append the upstream summary prefix as a user message. Remote Responses checkpoints
retain up to 64,000 text tokens of user history and append the encrypted checkpoint.
Remote failures never invoke the local compressor as a fallback. The local route is
selected in advance when the independent Compact Model uses a different provider
or endpoint from the conversation model, because encrypted checkpoints cannot be
assumed portable between providers. Unsupported replay of an encrypted checkpoint
fails explicitly rather than silently dropping it.

MyHarness preserves its independent Compact Model and Compact Thinking Effort
settings. It keeps system instructions outside stored conversation messages;
Codex-specific developer-message, hook-fragment, guardian and image-budget feature
flags have no equivalent in this host. Provider token usage anchors are retained;
unanchored estimates use UTF-8 bytes and opaque-checkpoint envelope accounting.

There is no percentage output target, output acceptance gate, two-round compressor,
or request-only post-compaction history projection. Historical session checkpoint
formats remain readable, but their compressors are not retained.
