import chalk from "chalk";
import { program } from "commander";
import inquirer from "inquirer";
import { createSpinner } from "nanospinner";
import fetch from "node-fetch";
import Trakt from "trakt.tv";

const SIMKL_OAUTH_PIN_URL = "https://api.simkl.com/oauth/pin";
const SIMKL_SYNC_URL =
  "https://api.simkl.com/sync/all-items/?extended=full&episode_watched_at=yes";
const SIMKL_DEVELOPER_URL = "https://simkl.com/settings/developer/new";
const TRAKT_APPLICATIONS_URL = "https://trakt.tv/oauth/applications";

program
  .name("Trakt Sync CLI")
  .description("Synchronize your watch history from Simkl to Trakt.")
  .version("1.0.0");

/**
 * Validates that input is not empty
 */
const validateInput = (input) => {
  if (!input || input.trim().length === 0) {
    return "This field cannot be empty!";
  }
  return true;
};

/**
 * Fetches JSON from a URL with error handling
 */
const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json();
};

/**
 * Authorizes with Simkl and fetches watch history
 */
async function getSimklWatched(clientId) {
  const spinner = createSpinner("Authorizing Simkl...").start();

  try {
    const { user_code, verification_url } = await fetchJson(
      `${SIMKL_OAUTH_PIN_URL}?client_id=${clientId}`,
    );

    console.log(
      chalk.cyan(
        `Please authorize the Simkl application by visiting: ${verification_url} and using this code: ${user_code}`,
      ),
    );

    await inquirer.prompt({
      type: "confirm",
      name: "confirmed",
      message: "Hit Enter once you have authorized.",
    });

    const { access_token } = await fetchJson(
      `${SIMKL_OAUTH_PIN_URL}/${user_code}?client_id=${clientId}`,
    );

    const data = await fetchJson(SIMKL_SYNC_URL, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
        "simkl-api-key": clientId,
      },
    });

    spinner.success({ text: "Simkl authorization successful." });
    return data;
  } catch (error) {
    spinner.error({ text: `Simkl authorization failed: ${error.message}` });
    throw error;
  }
}

/**
 * Prompts user for configuration
 */
async function getConfiguration() {
  return inquirer.prompt([
    {
      type: "input",
      message: `Please input your Simkl client ID (get it from ${SIMKL_DEVELOPER_URL} by creating a new application)\n`,
      name: "simkl_client_id",
      validate: validateInput,
    },
    {
      type: "input",
      message: `Please input your Trakt client ID (get it from ${TRAKT_APPLICATIONS_URL} by creating a new application):\n`,
      name: "client_id",
      validate: validateInput,
    },
    {
      type: "input",
      message:
        "Please input your Trakt client secret (you get it from the same place you got the client ID):\n",
      name: "client_secret",
      validate: validateInput,
    },
    {
      type: "confirm",
      message: "Do you want to delete your previous Trakt history? ",
      name: "remove_previous",
      default: false,
    },
  ]);
}

/**
 * Authorizes with Trakt
 */
async function authorizeTrakt(trakt) {
  const poll = await trakt.get_codes();
  console.log(
    chalk.blue(
      `Authorize the Trakt application via: ${poll.verification_url} using this code: ${poll.user_code}`,
    ),
  );
  await trakt.poll_access(poll);
}

/**
 * Removes previous Trakt watch history
 */
async function removePreviousHistory(trakt) {
  try {
    console.log("Getting previous watch history...");

    const moviesResponse = await trakt.sync.watched({ type: "movies" });
    const showsResponse = await trakt.sync.watched({ type: "shows" });

    const movies = moviesResponse.map((item) => item.movie);
    const shows = showsResponse.map((item) => item.show);

    console.log(
      `Removing ${movies.length} movies and ${shows.length} shows from your Trakt watchlist...`,
    );

    const result = await trakt.sync.history.remove({ movies, shows });
    console.log(
      `Successfully removed ${result.deleted.movies} movies and ${result.deleted.episodes} episodes from your watch history.`,
    );

    return true;
  } catch (error) {
    console.error(chalk.red(`Error removing history: ${error.message}`));
    const { confirm } = await inquirer.prompt([
      {
        name: "confirm",
        message:
          "The watch history could not be removed for various reasons (maybe your watch history is too big), continue syncing?",
        default: true,
        type: "boolean",
      },
    ]);
    return confirm;
  }
}

/**
 * Transforms Simkl show data to Trakt format
 */
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

/**
 * Transforms Simkl movie data to Trakt format
 */
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

/**
 * Builds Trakt sync object from Simkl watch history
 */
function buildTraktSyncObject(watched) {
  const shows = [...(watched.shows || []), ...(watched.anime || [])]
    .filter((item) => item.last_watched_at)
    .map(transformShow);

  const movies = (watched.movies || [])
    .filter((movie) => movie.last_watched_at)
    .map(transformMovie);

  return { shows, movies };
}

/**
 * Syncs watch history to Trakt
 */
async function syncToTrakt(watched, trakt) {
  const traktObject = buildTraktSyncObject(watched);

  console.log(
    `Syncing ${traktObject.shows.length} shows (incl. anime) and ${traktObject.movies.length} movies to your Trakt account...`,
  );

  const result = await trakt.sync.history.add(traktObject);
  console.log(
    chalk.green(
      `Successfully added ${result.added.movies} movies and ${result.added.episodes} episodes to your Trakt watch history!`,
    ),
  );
}

/**
 * Main function
 */
async function main() {
  try {
    const config = await getConfiguration();

    const spinner = createSpinner("Fetching watch history...").start();
    const watched = await getSimklWatched(config.simkl_client_id);
    spinner.success({ text: "Watch history fetched successfully." });

    const trakt = new Trakt({
      client_id: config.client_id,
      client_secret: config.client_secret,
    });

    const authSpinner = createSpinner("Authorizing Trakt...").start();
    await authorizeTrakt(trakt);
    authSpinner.success({ text: "Trakt authorization successful." });

    if (config.remove_previous) {
      const shouldContinue = await removePreviousHistory(trakt);
      if (!shouldContinue) {
        console.log(chalk.yellow("Sync cancelled by user."));
        process.exit(0);
      }
    }

    await syncToTrakt(watched, trakt);
  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

program
  .command("sync")
  .description("Sync watch history from Simkl to Trakt")
  .action(main);

program.parse(process.argv);
