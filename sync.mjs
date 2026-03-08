import * as p from "@clack/prompts";
import chalk from "chalk";
import { program } from "commander";
import gradient from "gradient-string";
import fetch from "node-fetch";
import { fileURLToPath } from "node:url";
import Trakt from "trakt.tv";

const SIMKL_PIN_URL = "https://api.simkl.com/oauth/pin";
const SIMKL_SYNC_URL =
  "https://api.simkl.com/sync/all-items/?extended=full&episode_watched_at=yes";
const SIMKL_DEV_URL = "https://simkl.com/settings/developer/new";
const TRAKT_APPS_URL = "https://trakt.tv/oauth/applications";

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
      client_secret: () =>
        p.password({
          message: "Trakt Client Secret",
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

  const trakt = new Trakt({
    client_id: config.client_id,
    client_secret: config.client_secret,
  });

  try {
    const codes = await trakt.get_codes();

    p.note(
      `Open  ${chalk.underline.cyan(codes.verification_url)}\n` +
        `Code  ${chalk.bold.yellow(codes.user_code)}`,
      "Authorize Trakt",
    );

    s.start("Waiting for authorization");
    await trakt.poll_access(codes);
    s.stop("Trakt authorized");
  } catch (err) {
    s.stop("Trakt auth failed");
    p.log.error(err.message);
    p.outro(
      chalk.red("Could not authorize Trakt — check your credentials."),
    );
    process.exit(1);
  }

  // ── Remove previous history (optional) ───────────────────

  if (config.remove_previous) {
    try {
      s.start("Clearing previous history");

      const [moviesRes, showsRes] = await Promise.all([
        trakt.sync.watched({ type: "movies" }),
        trakt.sync.watched({ type: "shows" }),
      ]);

      const result = await trakt.sync.history.remove({
        movies: moviesRes.map((i) => i.movie),
        shows: showsRes.map((i) => i.show),
      });

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

    const result = await trakt.sync.history.add(payload);
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
};
