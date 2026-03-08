import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (hoisted before imports) ────────────────────

function mockChalk() {
  const fn = (...args) => args[0] ?? "";
  return new Proxy(fn, {
    get: (_, prop) => {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return mockChalk();
    },
  });
}

vi.mock("chalk", () => ({ default: mockChalk() }));

vi.mock("gradient-string", () => ({
  default: () => (str) => str,
}));

const mockSpinner = { start: vi.fn(), stop: vi.fn() };

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  spinner: vi.fn(() => mockSpinner),
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  group: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock("node-fetch", () => ({
  default: vi.fn(),
}));

const mockTraktInstance = {
  get_codes: vi.fn(),
  poll_access: vi.fn(),
  sync: {
    watched: vi.fn(),
    history: {
      add: vi.fn(),
      remove: vi.fn(),
    },
  },
};

vi.mock("trakt.tv", () => ({
  default: vi.fn(function () {
    return mockTraktInstance;
  }),
}));

// ── Imports (resolved against mocks) ─────────────────────────

import { sync } from "../sync.mjs";
import fetch from "node-fetch";
import Trakt from "trakt.tv";
import * as p from "@clack/prompts";

// ── Fixtures ─────────────────────────────────────────────────

const SIMKL_WATCH_DATA = {
  shows: [
    {
      last_watched_at: "2024-01-15T20:00:00Z",
      show: {
        title: "Breaking Bad",
        year: 2008,
        ids: { imdb: "tt0903747", tmdb: 1396, mal: null, anidb: null },
      },
      seasons: [
        {
          number: 1,
          episodes: [{ number: 1, watched_at: "2024-01-10T20:00:00Z" }],
        },
      ],
    },
  ],
  anime: [
    {
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
    },
  ],
  movies: [
    {
      last_watched_at: "2024-03-01T18:00:00Z",
      movie: {
        title: "Inception",
        year: 2010,
        ids: { slug: "inception-2010", imdb: "tt1375666", tmdb: 27205 },
      },
    },
  ],
};

const DEFAULT_CONFIG = {
  simkl_client_id: "test-simkl-id",
  client_id: "test-trakt-id",
  client_secret: "test-trakt-secret",
  remove_previous: false,
};

// ── Helpers ──────────────────────────────────────────────────

function setupDefaultMocks(config = DEFAULT_CONFIG) {
  vi.spyOn(console, "log").mockImplementation(() => {});

  p.group.mockResolvedValue(config);
  p.confirm.mockResolvedValue(true);

  fetch.mockImplementation(async (url) => {
    if (url.includes("/oauth/pin?client_id=")) {
      return {
        ok: true,
        json: async () => ({
          user_code: "SIMKL_PIN",
          verification_url: "https://simkl.com/pin",
        }),
      };
    }
    if (url.includes("/oauth/pin/SIMKL_PIN")) {
      return {
        ok: true,
        json: async () => ({ access_token: "simkl_token_123" }),
      };
    }
    if (url.includes("/sync/all-items")) {
      return { ok: true, json: async () => SIMKL_WATCH_DATA };
    }
    return { ok: false, status: 404 };
  });

  mockTraktInstance.get_codes.mockResolvedValue({
    verification_url: "https://trakt.tv/activate",
    user_code: "TRAKT_CODE",
  });
  mockTraktInstance.poll_access.mockResolvedValue({});
  mockTraktInstance.sync.history.add.mockResolvedValue({
    added: { movies: 1, episodes: 2 },
  });
  mockTraktInstance.sync.watched.mockResolvedValue([]);
  mockTraktInstance.sync.history.remove.mockResolvedValue({
    deleted: { movies: 0, episodes: 0 },
  });
}

// ── Tests ────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSpinner.start.mockReset();
  mockSpinner.stop.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sync flow — happy path", () => {
  it("completes the full sync pipeline", async () => {
    setupDefaultMocks();

    await sync();

    expect(p.group).toHaveBeenCalledOnce();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/oauth/pin?client_id=test-simkl-id"),
      expect.anything(),
    );

    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("SIMKL_PIN"),
      "Authorize Simkl",
    );

    expect(p.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Done authorizing?" }),
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/oauth/pin/SIMKL_PIN?client_id=test-simkl-id"),
      expect.anything(),
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sync/all-items"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer simkl_token_123",
          "simkl-api-key": "test-simkl-id",
        }),
      }),
    );

    expect(Trakt).toHaveBeenCalledWith({
      client_id: "test-trakt-id",
      client_secret: "test-trakt-secret",
    });

    expect(mockTraktInstance.get_codes).toHaveBeenCalledOnce();
    expect(mockTraktInstance.poll_access).toHaveBeenCalledOnce();

    expect(mockTraktInstance.sync.history.add).toHaveBeenCalledWith(
      expect.objectContaining({
        shows: expect.arrayContaining([
          expect.objectContaining({ title: "Breaking Bad" }),
          expect.objectContaining({ title: "Attack on Titan" }),
        ]),
        movies: expect.arrayContaining([
          expect.objectContaining({ title: "Inception" }),
        ]),
      }),
    );

    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("1"),
      "Summary",
    );

    expect(p.outro).toHaveBeenCalledWith(
      expect.stringContaining("All done"),
    );
  });

  it("passes the correct number of shows and movies to Trakt", async () => {
    setupDefaultMocks();

    await sync();

    const addCall = mockTraktInstance.sync.history.add.mock.calls[0][0];
    expect(addCall.shows).toHaveLength(2);
    expect(addCall.movies).toHaveLength(1);
  });

  it("transforms ids correctly in the payload sent to Trakt", async () => {
    setupDefaultMocks();

    await sync();

    const payload = mockTraktInstance.sync.history.add.mock.calls[0][0];

    expect(payload.shows[0].ids.imdb).toBe("tt0903747");
    expect(payload.shows[1].ids.mal).toBe(16498);
    expect(payload.movies[0].ids.tmdb).toBe(27205);
  });
});

describe("sync flow — history removal", () => {
  it("removes previous history when requested", async () => {
    setupDefaultMocks({ ...DEFAULT_CONFIG, remove_previous: true });

    mockTraktInstance.sync.watched.mockImplementation(async ({ type }) => {
      if (type === "movies") return [{ movie: { ids: { tmdb: 1 } } }];
      if (type === "shows") return [{ show: { ids: { tmdb: 2 } } }];
      return [];
    });

    mockTraktInstance.sync.history.remove.mockResolvedValue({
      deleted: { movies: 1, episodes: 5 },
    });

    await sync();

    expect(mockTraktInstance.sync.watched).toHaveBeenCalledWith({
      type: "movies",
    });
    expect(mockTraktInstance.sync.watched).toHaveBeenCalledWith({
      type: "shows",
    });
    expect(mockTraktInstance.sync.history.remove).toHaveBeenCalledWith({
      movies: [{ ids: { tmdb: 1 } }],
      shows: [{ ids: { tmdb: 2 } }],
    });

    expect(mockTraktInstance.sync.history.add).toHaveBeenCalledOnce();
  });

  it("continues syncing when history removal fails and user confirms", async () => {
    setupDefaultMocks({ ...DEFAULT_CONFIG, remove_previous: true });

    mockTraktInstance.sync.watched.mockRejectedValue(
      new Error("Trakt API rate limit"),
    );

    p.confirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await sync();

    expect(p.log.warning).toHaveBeenCalledWith("Trakt API rate limit");
    expect(mockTraktInstance.sync.history.add).toHaveBeenCalledOnce();
  });
});

describe("sync flow — error handling", () => {
  it("exits on Simkl API error", async () => {
    setupDefaultMocks();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`EXIT_${code}`);
      });

    fetch.mockImplementation(async (url) => {
      if (url.includes("/oauth/pin?client_id=")) {
        return { ok: false, status: 401 };
      }
      return { ok: false, status: 500 };
    });

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("401"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits on Simkl token exchange failure", async () => {
    setupDefaultMocks();
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    fetch.mockImplementation(async (url) => {
      if (url.includes("/oauth/pin?client_id=")) {
        return {
          ok: true,
          json: async () => ({
            user_code: "PIN",
            verification_url: "https://simkl.com/pin",
          }),
        };
      }
      if (url.includes("/oauth/pin/PIN")) {
        return { ok: false, status: 403 };
      }
      return { ok: false, status: 500 };
    });

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalled();
  });

  it("exits on Trakt authorization failure", async () => {
    setupDefaultMocks();
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    mockTraktInstance.get_codes.mockRejectedValue(
      new Error("Invalid client_id"),
    );

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith("Invalid client_id");
  });

  it("exits on Trakt poll_access timeout", async () => {
    setupDefaultMocks();
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    mockTraktInstance.poll_access.mockRejectedValue(
      new Error("Polling expired"),
    );

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith("Polling expired");
  });

  it("exits on Trakt sync.history.add failure", async () => {
    setupDefaultMocks();
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    mockTraktInstance.sync.history.add.mockRejectedValue(
      new Error("Rate limit exceeded"),
    );

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith("Rate limit exceeded");
  });
});

describe("sync flow — Simkl authorization display", () => {
  it("shows the Simkl PIN code and verification URL", async () => {
    setupDefaultMocks();

    await sync();

    const noteCall = p.note.mock.calls.find(
      (call) => call[1] === "Authorize Simkl",
    );
    expect(noteCall).toBeDefined();
    expect(noteCall[0]).toContain("https://simkl.com/pin");
    expect(noteCall[0]).toContain("SIMKL_PIN");
  });

  it("shows the Trakt device code and verification URL", async () => {
    setupDefaultMocks();

    await sync();

    const noteCall = p.note.mock.calls.find(
      (call) => call[1] === "Authorize Trakt",
    );
    expect(noteCall).toBeDefined();
    expect(noteCall[0]).toContain("https://trakt.tv/activate");
    expect(noteCall[0]).toContain("TRAKT_CODE");
  });
});

describe("sync flow — spinner lifecycle", () => {
  it("starts and stops spinners for each phase", async () => {
    setupDefaultMocks();

    await sync();

    const starts = mockSpinner.start.mock.calls.map((c) => c[0]);
    const stops = mockSpinner.stop.mock.calls.map((c) => c[0]);

    expect(starts).toContain("Connecting to Simkl");
    expect(starts).toContain("Pulling watch history");
    expect(starts).toContain("Waiting for authorization");

    expect(stops).toContain("Connected to Simkl");
    expect(stops).toContain("Trakt authorized");
    expect(stops).toContain("Sync complete");
  });

  it("reports found counts in spinner stop message", async () => {
    setupDefaultMocks();

    await sync();

    const foundMsg = mockSpinner.stop.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("Found"),
    );
    expect(foundMsg).toBeDefined();
    expect(foundMsg[0]).toContain("2");
    expect(foundMsg[0]).toContain("1");
  });
});

describe("sync flow — edge cases", () => {
  it("handles watch history with no anime", async () => {
    setupDefaultMocks();

    const dataWithoutAnime = { ...SIMKL_WATCH_DATA, anime: [] };
    fetch.mockImplementation(async (url) => {
      if (url.includes("/oauth/pin?client_id=")) {
        return {
          ok: true,
          json: async () => ({
            user_code: "SIMKL_PIN",
            verification_url: "https://simkl.com/pin",
          }),
        };
      }
      if (url.includes("/oauth/pin/SIMKL_PIN")) {
        return {
          ok: true,
          json: async () => ({ access_token: "simkl_token_123" }),
        };
      }
      if (url.includes("/sync/all-items")) {
        return { ok: true, json: async () => dataWithoutAnime };
      }
      return { ok: false, status: 404 };
    });

    await sync();

    const payload = mockTraktInstance.sync.history.add.mock.calls[0][0];
    expect(payload.shows).toHaveLength(1);
    expect(payload.movies).toHaveLength(1);
  });

  it("handles watch history with only movies", async () => {
    setupDefaultMocks();

    const moviesOnly = { shows: [], anime: [], movies: SIMKL_WATCH_DATA.movies };
    fetch.mockImplementation(async (url) => {
      if (url.includes("/oauth/pin?client_id=")) {
        return {
          ok: true,
          json: async () => ({
            user_code: "SIMKL_PIN",
            verification_url: "https://simkl.com/pin",
          }),
        };
      }
      if (url.includes("/oauth/pin/SIMKL_PIN")) {
        return {
          ok: true,
          json: async () => ({ access_token: "simkl_token_123" }),
        };
      }
      if (url.includes("/sync/all-items")) {
        return { ok: true, json: async () => moviesOnly };
      }
      return { ok: false, status: 404 };
    });

    await sync();

    const payload = mockTraktInstance.sync.history.add.mock.calls[0][0];
    expect(payload.shows).toHaveLength(0);
    expect(payload.movies).toHaveLength(1);
  });
});
