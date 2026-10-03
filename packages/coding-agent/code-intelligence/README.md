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

The archives are not stored in the repository. Build them with
`npm run build:code-intelligence` (that is `node scripts/build-code-intelligence-artifacts.mjs`; output in
`.artifacts/code-intelligence/release/`, git-ignored), upload every `.zip` there
to the GitHub Release named by `releaseTag`, and run it with `--apply` to write
each archive's exact size and SHA-256 into `runtime-manifest.json` and mark it
`published`. The build downloads the language servers from their upstream
releases or npm; the Ruby module also needs an MSYS2 / RubyInstaller DevKit
directory in `MSYS2_PATH` to compile two gems. Do not rebuild after uploading:
the recorded hashes belong to the exact archives that were uploaded.

The installer refuses an archive whose size or SHA-256 differs from the
manifest, and refuses to download at all while `published` is `false` or the
metadata is missing, so an interrupted or tampered download cannot become an
active runtime. Until the archives are uploaded the release URLs answer HTTP 404
and the download fails without installing anything. Runtime files are stored
under `%USERPROFILE%\\.myharness\\agent\\code-intelligence\\`; project Session
data remains under the project `data\\` directory.

The notices in this directory belong to the language servers and shared
components they describe. They do not get replaced by the MyHarness
Apache-2.0 license.
