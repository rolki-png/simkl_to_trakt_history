# Simkl → Trakt History Sync

Transfer your watch history from **Simkl** to **Trakt.tv** with a guided, interactive CLI.

## Prerequisites

Before you begin, create an API app on each service:

| Service | Link |
|---------|------|
| Simkl   | [simkl.com/settings/developer/new](https://simkl.com/settings/developer/new/) |
| Trakt   | [trakt.tv/oauth/applications](https://trakt.tv/oauth/applications) |

You'll need the **Client ID** from Simkl, and the **Client ID + Client Secret** from Trakt.

## Quick start

```bash
# 1. Install Node.js (v15.3.0+) — https://nodejs.org
# 2. Clone this repo and cd into it
# 3. Install dependencies
npm install

# 4. Run the sync wizard
node sync.mjs
```

The wizard walks you through authentication and syncing step-by-step.

## Usage

```
Usage: simkl-to-trakt [options] [command]

Transfer your Simkl watch history to Trakt.tv

Options:
  -V, --version   output the version number
  -h, --help      display help for command

Commands:
  sync            Start the sync wizard (default)
  help [command]  display help for command
```

Running `node sync.mjs` without arguments starts the sync wizard directly.

## Clearing large Trakt histories

The built-in history removal works for most accounts. For very large histories, use:

- [TraktRater](https://github.com/damienhaynes/TraktRater)
- [Trakt history cleanup gist](https://gist.github.com/hugoboos/68b830aec8e7cab65055)

## License

MIT
