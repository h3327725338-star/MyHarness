> MyHarness can help you create MyHarness packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# MyHarness Packages

MyHarness packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `MyHarness` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a MyHarness Package](#creating-a-myharness-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** MyHarness packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

Packages are declared in the `packages` array of `settings.json`. User settings
(`~/.myharness/agent/settings.json`) apply everywhere; project settings
(`.myharness/settings.json`) apply to that project and are shared with your team.
On startup MyHarness installs missing packages and reconciles existing clones
after the project is trusted. The full shape is documented in
[settings.md](settings.md#packages).

```json
{
  "packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1", "./local/package"]
}
```

To try a package without adding it to settings, use `--extension` or `-e`. It is
loaded for the current run only:

```bash
myharness -e npm:@foo/bar
myharness -e git:github.com/user/repo
```

There are no `myharness install`, `remove`, `list`, `update` or `config` CLI
subcommands. The same operations exist only as library calls on
`DefaultPackageManager` (`install`, `remove`, `update`, `listConfiguredPackages`).
To uninstall MyHarness itself, see [Quickstart](quickstart.md#uninstall).

## Package Sources

MyHarness accepts three source types in the `packages` setting and in `--extension`.

### npm

```text
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned: startup resolution keeps the pinned version instead of moving to newer ones.
- User installs go under `~/.myharness/agent/npm/`.
- Project installs go under `.myharness/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```text
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits: startup reconciliation keeps an existing clone on the configured ref instead of moving it to a newer one.
- To move a package to a new pinned ref, edit its entry in the `packages` setting; the clone is reconciled to the new ref on next startup.
- Cloned to `~/.myharness/agent/git/<host>/<path>` (global) or `.myharness/git/<host>/<path>` (project).
- When reconciliation changes the checkout, MyHarness resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
myharness -e git:git@github.com:user/repo

# ssh:// protocol format
myharness -e ssh://git@github.com/user/repo

# With version ref
myharness -e git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```text
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, MyHarness loads resources using package rules.

## Creating a MyHarness Package

Add a `MyHarness` manifest to `package.json` or use conventional directories. Include the `myharness-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["myharness-package"],
  "myharness": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Gallery Metadata

MyHarness does not ship a package gallery in this source tree. Keep the
`myharness-package` keyword when publishing or sharing a package through the
registry or Git host you choose. Optional `video` and `image` fields can still
describe a package preview:

```json
{
  "name": "my-package",
  "keywords": ["myharness-package"],
  "myharness": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `MyHarness` manifest is present, MyHarness auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When MyHarness installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

MyHarness bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@myharness/ai`, `@myharness/agent-core`, `@myharness/coding-agent`, `typebox`.

Other MyHarness packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. MyHarness loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "myharness": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Resources from installed packages and local directories are enabled and disabled
through the `packages` setting in `settings.json`: drop a package from the array
to stop loading it, or keep it and pass `autoload: false` with per-type filters
to load only part of it. There is no `MyHarness config` TUI; edit user settings
for a global change and project settings for a project-local override.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
