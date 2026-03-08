# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Single-file Node.js CLI tool (`sync.mjs`) that transfers watch history from Simkl to Trakt.tv. No build step, no dev server, no database.

### Running the application

- `node sync.mjs sync` — starts the interactive sync workflow (prompts for API credentials)
- `node sync.mjs --help` — displays CLI usage
- The sync command is fully interactive and requires real Simkl and Trakt API credentials (Client IDs / secrets) plus OAuth authorization in a browser. See `README.md` for details on creating API apps.

### Lint / Test / Build

- **No linter configured** — the project has no ESLint, Prettier, or similar tooling.
- **No automated tests** — there are no test files or test framework dependencies.
- **No build step** — the app runs directly via `node sync.mjs` (ES Modules).

### Notes

- The `sync` command uses `@clack/prompts` for interactive prompts; piping input or running non-interactively requires special handling.
- Running `node sync.mjs` without arguments defaults to the `sync` command.
- Node.js >= 15.3.0 is required (top-level await / ES module support). The VM ships with Node v22+.
