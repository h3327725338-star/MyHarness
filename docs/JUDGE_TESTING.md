# Judge testing guide

This document is written for hackathon judges who need to run and evaluate MyHarness without prior context. It describes what to install, how to attach a model, and what to look at in five minutes. What MyHarness did on real runs, with every failure and its cause, is in the [evaluation](evaluation/README.md).

## What the project is

MyHarness is a personal AI for a Windows PC (Personal AI track). It works inside the websites you are already signed into, through a built-in browser the agent can drive. It keeps a persistent memory and user profile, runs scheduled tasks, and syncs memory, chats and schedules across your computers through your own Google Drive. It also handles coding: Coding mode works inside a project directory, and General mode handles research, writing and everyday tasks.

An Electron shell starts a local-only Web UI (`127.0.0.1`) and a shared backend. Sessions, settings and credentials stay on the PC.

The models are DeepSeek V4.1 Flash and NVIDIA Nemotron, served by Nebius Token Factory. Token Factory is built in: one API key sets up every role. Web search calls the Tavily API, which works without a key by default.

## Environment

- Windows 10 or Windows 11, x64.
- The installer from the Releases page. Alternatively, a source build needs Node.js `>=22.19.0` and Git for Windows.
- A Nebius Token Factory API key, only for model replies. **Judges:** judge-only Nebius Token Factory and Tavily API keys are in `MyHarness-Judge-Access-Keys.pdf`, the file attached to this project's Devpost submission under Additional info, which is for judges and organizers and does not appear on the public project page. Anyone else creates their own key: the app links to the Token Factory console. No key is stored in this repository.

## Install

1. Open the repository's [Releases](https://github.com/h3327725338-star/MyHarness/releases) page and pick the **MyHarness** release, not "Code Intelligence modules", which holds optional language-server packages. Download `MyHarness-Setup-<version>.exe`.
2. Run it. The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Choose **Only for me**, which needs no administrator rights and installs to `%LOCALAPPDATA%\Programs\MyHarness`, or choose all users. Pick the folder.
   - The installer speaks English or Simplified Chinese, following the Windows language.
   - It adds Start Menu and desktop shortcuts.
4. Start **MyHarness**. On the first start the interface follows Windows: Simplified Chinese on a Chinese Windows, English otherwise. You can change it in Settings → Appearance.

To uninstall, use Windows Settings → Apps → MyHarness. Uninstalling removes the program and its shortcuts. Your data in `%USERPROFILE%\.myharness` stays; delete that folder by hand to remove it too.

### Build from source

Use this if no installer is published for your review window, or to work from the code:

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev-desktop.cmd
```

`dev-desktop.cmd` builds, packages and starts the desktop app. The packaged app needs no external Node installation at runtime. Optional features, such as the Bash tool and language servers, keep their own requirements, listed in [Windows](../packages/coding-agent/docs/windows.md) and [Web Search](../packages/coding-agent/docs/web-search.md).

## Attach a model

Nebius Token Factory is built in, so attaching a model takes one API key.

**In the app:** until a model is set, the start screen shows **Connect NVIDIA Nemotron on Nebius**. It opens Settings → **Providers** → **Nebius Token Factory**.

1. Click **Get an API key**.
2. Sign in to Token Factory in the built-in browser and create a key.
3. Paste it into the strip above that page, or into the card in Settings.

Judges can skip steps 1 and 2 and paste the judge-only key from the Devpost file into that card.

MyHarness checks the key against the account's model list, adds DeepSeek V4.1 Flash and the NVIDIA Nemotron models, and gives each job its model:

- DeepSeek V4.1 Flash 1017: the main chat and commit descriptions. Ultra takes these when the account does not list DeepSeek.
- Nemotron 3 Ultra: sub-agents, conversation naming and translation.
- Nemotron 3.5 Lightning: compaction and the other helper jobs.
- Nemotron 3.5 Super VL: images.

Jobs you already set are left alone.

**From a file:** copy [`packages/coding-agent/docs/examples/nebius-models.json`](../packages/coding-agent/docs/examples/nebius-models.json) to `%USERPROFILE%\.myharness\agent\models.json`. Set `NEBIUS_TOKEN_FACTORY_API_KEY` in the environment, then start the app.

The exact model IDs, context windows and reasoning levels are in [NVIDIA Nemotron on Nebius Token Factory](../packages/coding-agent/docs/nebius-token-factory.md).

Without a Token Factory key the UI still starts and every non-model feature still works; only model replies need the key.

## Five-minute test script

Start each step in a new chat (**New chat** in the sidebar) unless it says otherwise. The models are not deterministic, so the wording will differ from run to run. Measured results for these workflows, failures included, are in the [evaluation](evaluation/README.md).

1. **Start.** A fresh install starts with a chat under **Default**, which belongs to no project. The composer shows **DeepSeek V4.1 Flash 1017**, which the setup made the main model, with a 1.0M context window.
2. **Web search with Tavily.** Ask: `What did NVIDIA announce about Nemotron 3.5 Lightning? Look it up on the web and give your sources.`
   - Web search is on by default. Tavily answers without a key through its free keyless access, and the search step lists the results it read.
   - **Get a free key** in Settings → **Web search** adds 1,000 searches a month. Judges can use **Add API key** there to add the judge-only Tavily key from the Devpost file instead.
3. **The built-in browser.** Ask: `Open https://github.com/h3327725338-star/MyHarness/releases in your browser and tell me the latest MyHarness version and what changed in it.`
   - Expected: the answer names version `0.0.6`. The agent works in its own background tab, so nothing jumps in front of you. The **Browser** button, the globe at the top right, shows its tabs.
   - To try a real sign-in, sign in to a site of your own in that browser, then ask about something behind it. The sign-in survives restarts. If a page needs a sign-in or a human check, a request bar appears on that tab and the agent waits for you.
4. **Memory across chats.** Send: `I'm vegetarian and allergic to peanuts, and I go to the gym on Mondays and Thursdays.` After the reply, wait about 30 seconds while Auto Memory saves it in the background. Then ask each of these in its own new chat:
   - `Which days do I go to the gym?` Expected: Mondays and Thursdays.
   - `Suggest a quick lunch for me.` Expected: vegetarian and without peanuts, with no reminder from you.
   - `What is my sister's name?` Expected: it says it does not know, because you never told it.
5. **A scheduled task.** Ask: `Remind me in 3 minutes to stand up and stretch.`
   - Expected: it confirms the time, and a card pops up when the time comes. Settings → **Scheduled tasks** lists what is set.
   - An agent task works the same way, for example `In 3 minutes, look up the weather in Kuala Lumpur and summarize it.` It starts a new chat at that time.
6. **An image.** Paste or drop a screenshot and ask what it says. Nemotron 3.5 Super VL reads it through the vision assistant, and the main model answers from its report.
7. **Which model does what.**
   - Settings → **Agent** shows which model each job uses.
   - Settings → **Providers** → **Nebius Token Factory**, first in the list, shows its Base URL and the models, the console links for balance and top-up, and this computer's spending estimate.
8. **Coding (optional).** Add a project folder (any Git repository, or this one) with **Add workspace**, the **+** in the sidebar, and ask: `Read package.json and list the packages/ directories, then summarize the repository structure. Do not modify any files.`
   - Expected: the agent calls file and shell tools itself, and the turn header reports elapsed time and operation count. The answer names version `0.0.6` and the five directories under `packages/`.
   - The **Changes** panel lists the turn's tool operations, and the same session is on disk under `%USERPROFILE%\.myharness\data\workspaces\<workspace-id>\sessions\` (a source build run from a checkout keeps it in that checkout's `data\workspaces\` instead).

## What to inspect in the source

- `packages/agent/`: the agent loop and harness contracts.
- `packages/ai/`: the Provider/API layer, request shaping and streaming.
- `packages/coding-agent/`: the product layer, with AgentSession, tools, sessions, settings and the Web UI server.
- `packages/desktop/`: the Electron shell, the built-in browser and packaging.
- `.github/workflows/ci.yml`: the two Windows runner jobs that gate every change.

## Known limitations

- Windows desktop x64 only. There is no hosted demo, because the product works on local files.
- The installer is not code-signed, so SmartScreen warns before the first run.
- Model replies need a Nebius Token Factory key, or another Provider. Without one the UI starts but no model answers.
- Token Factory has no balance API. The balance itself is only in its console; MyHarness shows a local estimate.
- Tavily rate-limits its keyless access. When the limit is used up, the search says so and links to a free key.
- Google Drive sync runs only while the app is open (the tray counts). The maintainer has run it for real across at least four PCs. Apart from the browser's sealed sign-in vault, the copy on Drive is not end-to-end encrypted.
- Symbols (semantic code navigation) needs optional per-language modules and is disabled by default.
- Settings and credentials live under `%USERPROFILE%\.myharness\agent\`, and an installed copy keeps its chats under `%USERPROFILE%\.myharness\data\` (a source build keeps them in the checkout's `data\` folder). Nothing is sent anywhere except the model, search and sync services you configure.
- MyHarness has no sandbox and no per-tool approval: the agent has its user's access to their own PC. The evaluation lists [everything else we measured or found](evaluation/README.md#limitations-and-problems-found).

## During the judging window

The judging period is December 9–23, 2026, Pacific Time. Until it ends:

- the repository stays public, with its Apache-2.0 license;
- the installer stays downloadable from the Releases page.

If a build asset is missing or a link is broken, open an issue on the repository or contact the submitter through Devpost.
