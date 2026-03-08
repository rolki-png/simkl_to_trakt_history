# AGENTS.md

## Cursor Cloud specific instructions

This is a single-file Node.js CLI tool (`sync.mjs`) that transfers watch history from Simkl to Trakt. There is no build step, no test suite, no linter, no web UI, and no backend server.

### Running the application

- `node sync.mjs --help` — shows CLI usage
- `node sync.mjs sync` — starts the interactive sync flow (requires Simkl and Trakt API credentials)

### Key caveats

- The `sync` command is fully interactive (uses `inquirer` prompts). It cannot be run non-interactively without piping input.
- The tool requires external API credentials: a Simkl client ID and a Trakt client ID + secret. These must be obtained by creating developer apps on [simkl.com](https://simkl.com/settings/developer/new/) and [trakt.tv](https://trakt.tv/oauth/applications) respectively.
- There are no automated tests, no lint configuration, and no build step in this project. Validation is limited to checking that the CLI starts and shows help/prompts correctly.
- The project uses ES modules (`.mjs`); Node.js >= 15.3.0 is required.
