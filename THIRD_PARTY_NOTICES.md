# Third-party notices

MyHarness itself is licensed under Apache-2.0. That license applies to the
MyHarness work that its contributors are authorized to license; it does not
relicense third-party or inherited material.

The repository retains third-party notices in the location closest to the
material they cover:

- `packages/tui/src/stdin-buffer.ts` and its test retain the OpenTUI MIT
  attribution.
- `packages/coding-agent/src/utils/ansi.ts` retains the ansi-regex and
  strip-ansi MIT attribution from Sindre Sorhus.
- `packages/coding-agent/src/exports/html/vendor/marked.min.js` retains the
  MarkedJS and Christopher Jeffrey notices, and `highlight.min.js` retains its
  BSD-3-Clause notice.
- `packages/coding-agent/web/vendor/` contains the Web UI runtime libraries
  Preact (MIT, Jason Miller; `LICENSE.preact`) and htm (Apache-2.0, Jason
  Miller; `LICENSE.htm`) as unmodified ES module builds, except that the bare
  `preact` import in `preact-hooks.js` is rewritten to a relative path so the
  page needs no import map. The Web UI also loads the `marked` and
  `highlight.js` files listed above.
- `packages/agent/src/harness/compaction/CODEX-NOTICE.md` and
  `CODEX-LICENSE` identify the adapted OpenAI Codex source and its Apache-2.0
  terms.
- `packages/coding-agent/examples/extensions/doom-overlay/` contains the
  doomgeneric/WebAssembly demo and identifies id Software, doomgeneric and
  pi-doom in its README. Those inherited game/demo assets and their terms are
  not relicensed by the MyHarness Apache-2.0 notice.
- The optional Windows Code Intelligence catalog and its redistribution files
  are recorded in
  `packages/coding-agent/code-intelligence/DEPENDENCY-MANIFEST.json` and
  `packages/coding-agent/code-intelligence/licenses/`. This includes the
  component-specific MIT, Apache/LLVM, BSD, EPL, Microsoft, and other notices.

The large Code Intelligence archives are not tracked in this source tree and
the current release manifest is unpublished. The files above are still kept so
that a future release archive can be accompanied by the notices required by
its actual contents.

Package names, compatibility aliases, inherited package authors, and old
changelog entries are provenance or compatibility information; they are not
claims that MyHarness owns the corresponding third-party work.
