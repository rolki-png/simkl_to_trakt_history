import * as p from "@clack/prompts";
import chalk from "chalk";
import { program } from "commander";
import gradient from "gradient-string";
import fetch from "node-fetch";
import { fileURLToPath } from "node:url";

const SIMKL_PIN_URL = "https://api.simkl.com/oauth/pin";
const SIMKL_SYNC_URL =
  "https://api.simkl.com/sync/all-items/?extended=full&episode_watched_at=yes";
const SIMKL_DEV_URL = "https://simkl.com/settings/developer/new";
const TRAKT_APPS_URL = "https://trakt.tv/oauth/applications";
const TRAKT_AUTH_URL = "https://auth.trakt.tv";
const TRAKT_API_URL = "https://api.trakt.tv";

const DEVICE_TOKEN_ERRORS = {
  404: "Invalid device code.",
  409: "This code was already used.",
  410: "Authorization expired.",
  418: "Authorization denied.",
};

const brand = gradient(["#a78bfa", "#818cf8", "#6366f1", "#4f46e5"]);

// ── Helpers ──────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
  return res.json();
}

function bail(message = "Cancelled.") {
  p.cancel(message);
  process.exit(0);
}

function safeSpinner() {
  const s = p.spinner();
  let active = false;
  return {
    start(msg) {
      s.start(msg);
      active = true;
    },
    stop(msg) {
      if (active) {
        s.stop(msg);
        active = false;
      }
    },
  };
}

// ── Data transforms ──────────────────────────────────────────

const transformShow = (show) => ({
  watched_at: show.last_watched_at,
  title: show.show.title,
  year: show.show.year,
  seasons: show.seasons,
  ids: {
    mal: show.show.ids?.mal,
    imdb: show.show.ids?.imdb,
    tmdb: show.show.ids?.tmdb,
    anidb: show.show.ids?.anidb,
  },
});

const transformMovie = (movie) => ({
  watched_at: movie.last_watched_at,
  title: movie.movie.title,
  year: movie.movie.year,
  ids: {
    slug: movie.movie.ids?.slug,
    imdb: movie.movie.ids?.imdb,
    tmdb: movie.movie.ids?.tmdb,
  },
});

function buildSyncPayload(watched) {
  const shows = [...(watched.shows || []), ...(watched.anime || [])]
    .filter((i) => i.last_watched_at)
    .map(transformShow);

  const movies = (watched.movies || [])
    .filter((m) => m.last_watched_at)
    .map(transformMovie);

  return { shows, movies };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestDeviceCode(clientId) {
  return fetchJson(`${TRAKT_AUTH_URL}/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
}

async function pollDeviceToken(clientId, device) {
  const expiresIn = Number(device.expires_in ?? 600);
  const deadline = Date.now() + expiresIn * 1000;
  let waitMs = Math.max(0, Number(device.interval ?? 5)) * 1000;

  while (Date.now() < deadline) {
    await sleep(waitMs);
    if (Date.now() >= deadline) break;

    const res = await fetch(`${TRAKT_AUTH_URL}/oauth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: device.device_code,
        client_id: clientId,
      }),
    });

    if (res.status === 200) return res.json();
    if (res.status === 400) continue;
    if (res.status === 429) {
      waitMs += 1000;
      continue;
    }

    throw new Error(
      DEVICE_TOKEN_ERRORS[res.status] ??
        `Trakt authorization failed (HTTP ${res.status})`,
    );
  }

  throw new Error("Authorization expired.");
}

async function traktRequest(
  clientId,
  accessToken,
  path,
  { method = "GET", body } = {},
) {
  return fetchJson(`${TRAKT_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ── Main sync flow ───────────────────────────────────────────

async function sync() {
  console.log();
  console.log(brand("  ■ simkl → trakt"));
  console.log(chalk.dim("  transfer your watch history\n"));

  p.intro(chalk.inverse(` v${program.version()} `));

  p.log.info(
    [
      chalk.dim("You need API apps from both services:"),
      chalk.dim(`  Simkl  `) + chalk.dim.underline(SIMKL_DEV_URL),
      chalk.dim(`  Trakt  `) + chalk.dim.underline(TRAKT_APPS_URL),
    ].join("\n"),
  );

  // ── Credentials ──────────────────────────────────────────

  const config = await p.group(
    {
      simkl_client_id: () =>
        p.text({
          message: "Simkl Client ID",
          placeholder: "paste from your Simkl app",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        }),
      client_id: () =>
        p.text({
          message: "Trakt Client ID",
          placeholder: "paste from your Trakt app",
          validate: (v) => (!v?.trim() ? "Required" : undefined),
        }),
      remove_previous: () =>
        p.confirm({
          message: "Wipe existing Trakt history first?",
          initialValue: false,
        }),
    },
    { onCancel: () => bail() },
  );

  // ── Simkl auth + fetch ───────────────────────────────────

  const s = safeSpinner();
  s.start("Connecting to Simkl");

  let watched;
  let payload;
  try {
    const pin = await fetchJson(
      `${SIMKL_PIN_URL}?client_id=${config.simkl_client_id}`,
    );
    s.stop("Connected to Simkl");

    p.note(
      `Open  ${chalk.underline.cyan(pin.verification_url)}\n` +
        `Code  ${chalk.bold.yellow(pin.user_code)}`,
      "Authorize Simkl",
    );

    const ok = await p.confirm({ message: "Done authorizing?" });
    if (p.isCancel(ok) || !ok) bail();

    s.start("Pulling watch history");

    const { access_token } = await fetchJson(
      `${SIMKL_PIN_URL}/${pin.user_code}?client_id=${config.simkl_client_id}`,
    );

    watched = await fetchJson(SIMKL_SYNC_URL, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
        "simkl-api-key": config.simkl_client_id,
      },
    });

    payload = buildSyncPayload(watched);
    s.stop(
      `Found ${chalk.bold(payload.shows.length)} shows and ${chalk.bold(payload.movies.length)} movies`,
    );
  } catch (err) {
    s.stop("Simkl failed");
    p.log.error(err.message);
    p.outro(chalk.red("Could not fetch Simkl data — check your Client ID."));
    process.exit(1);
  }

  // ── Trakt auth ───────────────────────────────────────────

  const clientId = config.client_id.trim();
  let accessToken;
  try {
    const codes = await requestDeviceCode(clientId);

    p.note(
      `Open  ${chalk.underline.cyan(codes.verification_url)}\n` +
        `Code  ${chalk.bold.yellow(codes.user_code)}`,
      "Authorize Trakt",
    );

    s.start("Waiting for authorization");
    const token = await pollDeviceToken(clientId, codes);
    accessToken = token.access_token;
    s.stop("Trakt authorized");
  } catch (err) {
    s.stop("Trakt auth failed");
    p.log.error(err.message);
    p.outro(
      chalk.red("Could not authorize Trakt — check your Client ID."),
    );
    process.exit(1);
  }

  // ── Remove previous history (optional) ───────────────────

  if (config.remove_previous) {
    try {
      s.start("Clearing previous history");

      const [moviesRes, showsRes] = await Promise.all([
        traktRequest(clientId, accessToken, "/sync/watched/movies"),
        traktRequest(clientId, accessToken, "/sync/watched/shows"),
      ]);

      const result = await traktRequest(
        clientId,
        accessToken,
        "/sync/history/remove",
        {
          method: "POST",
          body: {
            movies: moviesRes.map((i) => i.movie),
            shows: showsRes.map((i) => i.show),
          },
        },
      );

      s.stop(
        `Removed ${chalk.yellow(result.deleted.movies)} movies and ${chalk.yellow(result.deleted.episodes)} episodes`,
      );
    } catch (err) {
      s.stop("Cleanup failed");
      p.log.warning(err.message);

      const cont = await p.confirm({
        message: "Continue syncing anyway?",
        initialValue: true,
      });
      if (p.isCancel(cont) || !cont) bail();
    }
  }

  // ── Sync to Trakt ────────────────────────────────────────

  try {
    s.start(
      `Syncing ${payload.shows.length} shows and ${payload.movies.length} movies`,
    );

    const result = await traktRequest(clientId, accessToken, "/sync/history", {
      method: "POST",
      body: payload,
    });
    s.stop("Sync complete");

    p.note(
      [
        `Movies   ${chalk.green.bold(result.added.movies)} added`,
        `Episodes ${chalk.green.bold(result.added.episodes)} added`,
      ].join("\n"),
      "Summary",
    );
  } catch (err) {
    s.stop("Sync failed");
    p.log.error(err.message);
    p.outro(chalk.red("Sync failed."));
    process.exit(1);
  }

  p.outro("All done — enjoy your history on Trakt!");
}

// ── CLI ──────────────────────────────────────────────────────

program
  .name("simkl-to-trakt")
  .description("Transfer your Simkl watch history to Trakt.tv")
  .version("1.0.1");

program
  .command("sync", { isDefault: true })
  .description("Start the sync wizard")
  .action(sync);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  program.parse();
}

export {
  fetchJson,
  transformShow,
  transformMovie,
  buildSyncPayload,
  safeSpinner,
  sync,
  TRAKT_AUTH_URL,
  TRAKT_API_URL,
};
