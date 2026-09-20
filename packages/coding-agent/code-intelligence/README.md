# MyHarness Code Intelligence modules

The default `symbols` capability is the lightweight source index shipped with
MyHarness. It does not download a language server. Windows x64 users can open
`/settings` → `Code Intelligence` and install semantic support per language.

- `runtime-manifest.json` is the checked-in install contract. It lists language
  modules, shared dependencies, versions, expected archive paths, release URL
  templates, the compatible MyHarness version range, exact sizes, and SHA-256
  fields.
- `lsp-launcher.mjs` is the small launcher used by installed modules. It reads
  only the selected module and its referenced shared components.
- `licenses/` and `DEPENDENCY-MANIFEST.json` contain redistribution notices for
  the source catalog. They remain separate from user-installed runtime data.

The current repository deliberately has no published module hashes or archive
assets (`published` is `false` in the manifest). The UI reports these modules
as unavailable and the installer refuses to download until a release supplies
exact metadata, so an interrupted or tampered download cannot become an active
runtime. Runtime files are stored
under `%USERPROFILE%\\.myharness\\agent\\code-intelligence\\`; project Session
data remains under the project `data\\` directory.

The notices in this directory belong to the language servers and shared
components they describe. They do not get replaced by the MyHarness
Apache-2.0 license.
