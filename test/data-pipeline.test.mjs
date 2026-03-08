import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import {
  transformShow,
  transformMovie,
  buildSyncPayload,
  fetchJson,
} from "../sync.mjs";

// ── Fixtures ─────────────────────────────────────────────────

const SIMKL_SHOW = {
  last_watched_at: "2024-01-15T20:00:00Z",
  show: {
    title: "Breaking Bad",
    year: 2008,
    ids: { imdb: "tt0903747", tmdb: 1396, mal: null, anidb: null },
  },
  seasons: [
    {
      number: 1,
      episodes: [
        { number: 1, watched_at: "2024-01-10T20:00:00Z" },
        { number: 2, watched_at: "2024-01-11T20:00:00Z" },
      ],
    },
  ],
};

const SIMKL_ANIME = {
  last_watched_at: "2024-02-01T15:00:00Z",
  show: {
    title: "Attack on Titan",
    year: 2013,
    ids: { mal: 16498, anidb: 9541, imdb: "tt2560140", tmdb: 1429 },
  },
  seasons: [
    {
      number: 1,
      episodes: [{ number: 1, watched_at: "2024-01-20T15:00:00Z" }],
    },
  ],
};

const SIMKL_MOVIE = {
  last_watched_at: "2024-03-01T18:00:00Z",
  movie: {
    title: "Inception",
    year: 2010,
    ids: { slug: "inception-2010", imdb: "tt1375666", tmdb: 27205 },
  },
};

// ── transformShow ────────────────────────────────────────────

describe("transformShow", () => {
  it("maps a Simkl show to Trakt format", () => {
    const result = transformShow(SIMKL_SHOW);

    expect(result).toEqual({
      watched_at: "2024-01-15T20:00:00Z",
      title: "Breaking Bad",
      year: 2008,
      seasons: SIMKL_SHOW.seasons,
      ids: { imdb: "tt0903747", tmdb: 1396, mal: null, anidb: null },
    });
  });

  it("maps anime with mal/anidb ids", () => {
    const result = transformShow(SIMKL_ANIME);

    expect(result.ids.mal).toBe(16498);
    expect(result.ids.anidb).toBe(9541);
    expect(result.title).toBe("Attack on Titan");
  });

  it("handles missing ids gracefully", () => {
    const input = {
      last_watched_at: "2024-01-01T00:00:00Z",
      show: { title: "No IDs", year: 2024, ids: {} },
      seasons: [],
    };
    const result = transformShow(input);

    expect(result.ids.mal).toBeUndefined();
    expect(result.ids.imdb).toBeUndefined();
    expect(result.ids.tmdb).toBeUndefined();
    expect(result.ids.anidb).toBeUndefined();
  });

  it("preserves seasons structure unchanged", () => {
    const result = transformShow(SIMKL_SHOW);

    expect(result.seasons).toBe(SIMKL_SHOW.seasons);
    expect(result.seasons[0].episodes).toHaveLength(2);
  });
});

// ── transformMovie ───────────────────────────────────────────

describe("transformMovie", () => {
  it("maps a Simkl movie to Trakt format", () => {
    const result = transformMovie(SIMKL_MOVIE);

    expect(result).toEqual({
      watched_at: "2024-03-01T18:00:00Z",
      title: "Inception",
      year: 2010,
      ids: { slug: "inception-2010", imdb: "tt1375666", tmdb: 27205 },
    });
  });

  it("handles missing ids gracefully", () => {
    const input = {
      last_watched_at: "2024-01-01T00:00:00Z",
      movie: { title: "No IDs", year: 2024, ids: {} },
    };
    const result = transformMovie(input);

    expect(result.ids.slug).toBeUndefined();
    expect(result.ids.imdb).toBeUndefined();
    expect(result.ids.tmdb).toBeUndefined();
  });
});

// ── buildSyncPayload ─────────────────────────────────────────

describe("buildSyncPayload", () => {
  it("merges shows and anime into a single shows array", () => {
    const watched = {
      shows: [SIMKL_SHOW],
      anime: [SIMKL_ANIME],
      movies: [SIMKL_MOVIE],
    };
    const result = buildSyncPayload(watched);

    expect(result.shows).toHaveLength(2);
    expect(result.shows[0].title).toBe("Breaking Bad");
    expect(result.shows[1].title).toBe("Attack on Titan");
    expect(result.movies).toHaveLength(1);
    expect(result.movies[0].title).toBe("Inception");
  });

  it("filters out items without last_watched_at", () => {
    const watched = {
      shows: [
        SIMKL_SHOW,
        {
          last_watched_at: null,
          show: { title: "Unwatched", year: 2020, ids: {} },
          seasons: [],
        },
      ],
      anime: [],
      movies: [
        SIMKL_MOVIE,
        {
          last_watched_at: null,
          movie: { title: "Unwatched Movie", year: 2021, ids: {} },
        },
      ],
    };
    const result = buildSyncPayload(watched);

    expect(result.shows).toHaveLength(1);
    expect(result.movies).toHaveLength(1);
  });

  it("handles completely empty watch history", () => {
    const result = buildSyncPayload({ shows: [], anime: [], movies: [] });

    expect(result.shows).toEqual([]);
    expect(result.movies).toEqual([]);
  });

  it("handles missing categories (undefined)", () => {
    const result = buildSyncPayload({});

    expect(result.shows).toEqual([]);
    expect(result.movies).toEqual([]);
  });

  it("handles anime-only history (no shows key)", () => {
    const watched = { anime: [SIMKL_ANIME], movies: [] };
    const result = buildSyncPayload(watched);

    expect(result.shows).toHaveLength(1);
    expect(result.shows[0].title).toBe("Attack on Titan");
  });

  it("produces correct Trakt ids from Simkl ids", () => {
    const watched = {
      shows: [SIMKL_SHOW],
      anime: [SIMKL_ANIME],
      movies: [SIMKL_MOVIE],
    };
    const result = buildSyncPayload(watched);

    expect(result.shows[0].ids.imdb).toBe("tt0903747");
    expect(result.shows[1].ids.mal).toBe(16498);
    expect(result.movies[0].ids.tmdb).toBe(27205);
  });
});

// ── fetchJson (real HTTP server) ─────────────────────────────

describe("fetchJson integration", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", items: [1, 2, 3] }));
      } else if (req.url === "/error-500") {
        res.writeHead(500);
        res.end("Internal Server Error");
      } else if (req.url === "/error-404") {
        res.writeHead(404);
        res.end("Not Found");
      } else if (req.url === "/check-headers") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            auth: req.headers.authorization,
            apiKey: req.headers["x-api-key"],
            contentType: req.headers["content-type"],
          }),
        );
      } else if (req.url === "/empty-json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else if (req.url === "/nested") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            user: { name: "test", settings: { theme: "dark" } },
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("fetches and parses a valid JSON response", async () => {
    const data = await fetchJson(`${baseUrl}/json`);

    expect(data).toEqual({ status: "ok", items: [1, 2, 3] });
  });

  it("throws on HTTP 500", async () => {
    await expect(fetchJson(`${baseUrl}/error-500`)).rejects.toThrow(
      "Request failed (HTTP 500)",
    );
  });

  it("throws on HTTP 404", async () => {
    await expect(fetchJson(`${baseUrl}/error-404`)).rejects.toThrow(
      "Request failed (HTTP 404)",
    );
  });

  it("forwards custom headers to the server", async () => {
    const data = await fetchJson(`${baseUrl}/check-headers`, {
      headers: {
        Authorization: "Bearer test_token_123",
        "x-api-key": "my-api-key",
        "Content-Type": "application/json",
      },
    });

    expect(data.auth).toBe("Bearer test_token_123");
    expect(data.apiKey).toBe("my-api-key");
    expect(data.contentType).toBe("application/json");
  });

  it("parses empty JSON object", async () => {
    const data = await fetchJson(`${baseUrl}/empty-json`);

    expect(data).toEqual({});
  });

  it("parses deeply nested JSON", async () => {
    const data = await fetchJson(`${baseUrl}/nested`);

    expect(data.user.settings.theme).toBe("dark");
  });
});
