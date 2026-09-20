# Termux (Android) Setup

MyHarness runs on Android via [Termux](https://termux.dev/), a terminal emulator and Linux environment for Android.

## Prerequisites

1. Install [Termux](https://github.com/termux/termux-app#installation) from GitHub or F-Droid (not Google Play, that version is deprecated)
2. Install [Termux:API](https://github.com/termux/termux-api#installation) from GitHub or F-Droid for clipboard and other device integrations

## Installation

```bash
# Update packages
pkg update && pkg upgrade

# Install dependencies
pkg install nodejs termux-api git

# The public npm package is not available yet. Use an authorized source
# checkout (copy one from a supported host or clone the repository when you
# have access), then run the workspace build documented in the development
# guide.
git clone <authorized-repository-url> myharness-src
cd myharness-src
npm install --ignore-scripts
npm run build:offline

# Create config directory
mkdir -p ~/.myharness/agent

# Run the source-built CLI
node packages/coding-agent/dist/cli.js

# After a future npm publication, the shorter global-install flow will be:
# npm install -g --ignore-scripts @myharness/coding-agent
# myharness
```

## Clipboard Support

Clipboard operations use `termux-clipboard-set` for writing when running in Termux (requires the Termux:API app); MyHarness falls back to OSC 52 when that command fails. Reading from clipboard (`termux-clipboard-get`) is not currently implemented in MyHarness; only the native addon path is used for clipboard reads.

Image clipboard is not supported on Termux (the `ctrl+v` image paste feature will not work).

## Example AGENTS.md for Termux

Create `~/.myharness/agent/AGENTS.md` to help the agent understand the Termux environment:

````markdown
# Agent Environment: Termux on Android

## Location
- **OS**: Android (Termux terminal emulator)
- **Home**: `/data/data/com.termux/files/home`
- **Prefix**: `/data/data/com.termux/files/usr`
- **Shared storage**: `/storage/emulated/0` (Downloads, Documents, etc.)

## Opening URLs
```bash
termux-open-url "https://example.com"
```

## Opening Files
```bash
termux-open file.pdf          # Opens with default app
termux-open --chooser image.jpg      # Choose app
```

## Clipboard
```bash
termux-clipboard-set "text"   # Copy
termux-clipboard-get          # Paste
```

## Notifications
```bash
termux-notification -t "Title" -c "Content"
```

## Device Info
```bash
termux-battery-status         # Battery info
termux-wifi-connectioninfo    # WiFi info
termux-telephony-deviceinfo   # Device info
```

## Sharing
```bash
termux-share -a send file.txt # Share file
```

## Other Useful Commands
```bash
termux-toast "message"        # Quick toast popup
termux-vibrate                # Vibrate device
termux-tts-speak "hello"      # Text to speech
termux-camera-photo out.jpg   # Take photo
```

## Notes
- Termux:API app must be installed for `termux-*` commands
- Use `pkg install termux-api` for the command-line tools
- Storage permission needed for `/storage/emulated/0` access
````

## Limitations

- **No image clipboard**: Termux clipboard API only supports text
- **No native binaries**: Some optional native dependencies (like the clipboard module) are unavailable on Android ARM64 and are skipped during installation
- **Storage access**: To access files in `/storage/emulated/0` (Downloads, etc.), run `termux-setup-storage` once to grant permissions

## Troubleshooting

### Clipboard not working

Ensure both apps are installed:
1. Termux (from GitHub or F-Droid)
2. Termux:API (from GitHub or F-Droid)

Then install the CLI tools:
```bash
pkg install termux-api
```

### Permission denied for shared storage

Run once to grant storage permissions:
```bash
termux-setup-storage
```

### Node.js installation issues

If npm fails, try clearing the cache:
```bash
npm cache clean --force
```
