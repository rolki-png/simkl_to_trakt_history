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

// ── Imports (resolved against mocks) ─────────────────────────

import {
  sync,
  safeSpinner,
  TRAKT_AUTH_URL,
  TRAKT_API_URL,
} from "../sync.mjs";
import fetch from "node-fetch";
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
  remove_previous: false,
};

const TRAKT_DEVICE = {
  device_code: "device-code",
  user_code: "TRAKT_CODE",
  verification_url: "https://trakt.tv/activate",
  expires_in: 600,
  interval: 0,
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function watchedMovies() {
  return [];
}

function watchedShows() {
  return [];
}

function setupDefaultMocks(config = DEFAULT_CONFIG, overrides = {}) {
  vi.spyOn(console, "log").mockImplementation(() => {});

  p.group.mockResolvedValue(config);
  p.confirm.mockResolvedValue(true);

  const state = {
    movies: overrides.movies ?? watchedMovies,
    shows: overrides.shows ?? watchedShows,
    removeResult: overrides.removeResult ?? {
      deleted: { movies: 0, episodes: 0 },
    },
    addResult: overrides.addResult ?? { added: { movies: 1, episodes: 2 } },
    device: overrides.device ?? TRAKT_DEVICE,
    tokenStatus: overrides.tokenStatus ?? 200,
    tokenBody: overrides.tokenBody ?? { access_token: "trakt_token" },
    deviceCodeStatus: overrides.deviceCodeStatus ?? 200,
    simklData: overrides.simklData ?? SIMKL_WATCH_DATA,
    simklPinStatus: overrides.simklPinStatus ?? 200,
    simklTokenStatus: overrides.simklTokenStatus ?? 200,
  };

  fetch.mockImplementation(async (url, options = {}) => {
    if (url.includes("/oauth/pin?client_id=")) {
      if (state.simklPinStatus !== 200) {
        return jsonResponse(state.simklPinStatus, {});
      }
      return jsonResponse(200, {
        user_code: "SIMKL_PIN",
        verification_url: "https://simkl.com/pin",
      });
    }
    if (url.includes("/oauth/pin/SIMKL_PIN") || url.includes("/oauth/pin/PIN")) {
      if (state.simklTokenStatus !== 200) {
        return jsonResponse(state.simklTokenStatus, {});
      }
      return jsonResponse(200, { access_token: "simkl_token_123" });
    }
    if (url.includes("/sync/all-items")) {
      return jsonResponse(200, state.simklData);
    }
    if (url === `${TRAKT_AUTH_URL}/oauth/device/code`) {
      if (state.deviceCodeStatus !== 200) {
        return jsonResponse(state.deviceCodeStatus, {});
      }
      return jsonResponse(200, state.device);
    }
    if (url === `${TRAKT_AUTH_URL}/oauth/device/token`) {
      return jsonResponse(state.tokenStatus, state.tokenBody);
    }
    if (url === `${TRAKT_API_URL}/sync/watched/movies`) {
      const movies =
        typeof state.movies === "function" ? state.movies() : state.movies;
      return jsonResponse(200, movies);
    }
    if (url === `${TRAKT_API_URL}/sync/watched/shows`) {
      const shows =
        typeof state.shows === "function" ? state.shows() : state.shows;
      return jsonResponse(200, shows);
    }
    if (url === `${TRAKT_API_URL}/sync/history/remove`) {
      return jsonResponse(200, state.removeResult);
    }
    if (url === `${TRAKT_API_URL}/sync/history` && options.method === "POST") {
      return jsonResponse(200, state.addResult);
    }
    return jsonResponse(404, {});
  });
}

function callsTo(url) {
  return fetch.mock.calls.filter((call) => call[0] === url);
}

function bodyOf(call) {
  return JSON.parse(call[1].body);
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

    const promptFields = p.group.mock.calls[0][0];
    expect(promptFields).not.toHaveProperty("client_secret");
    expect(Object.keys(promptFields)).toEqual([
      "simkl_client_id",
      "client_id",
      "remove_previous",
    ]);

    const deviceCodeCall = callsTo(`${TRAKT_AUTH_URL}/oauth/device/code`)[0];
    expect(bodyOf(deviceCodeCall)).toEqual({ client_id: "test-trakt-id" });
    expect(bodyOf(deviceCodeCall)).not.toHaveProperty("client_secret");

    const deviceTokenCall = callsTo(`${TRAKT_AUTH_URL}/oauth/device/token`)[0];
    expect(bodyOf(deviceTokenCall)).toEqual({
      code: "device-code",
      client_id: "test-trakt-id",
    });

    const addCall = callsTo(`${TRAKT_API_URL}/sync/history`).find(
      (call) => call[1]?.method === "POST",
    );
    expect(addCall[1].headers).toMatchObject({
      Authorization: "Bearer trakt_token",
      "trakt-api-key": "test-trakt-id",
      "trakt-api-version": "2",
    });
    expect(bodyOf(addCall)).toEqual(
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

    const addCall = callsTo(`${TRAKT_API_URL}/sync/history`).find(
      (call) => call[1]?.method === "POST",
    );
    const payload = bodyOf(addCall);
    expect(payload.shows).toHaveLength(2);
    expect(payload.movies).toHaveLength(1);
  });

  it("transforms ids correctly in the payload sent to Trakt", async () => {
    setupDefaultMocks();

    await sync();

    const addCall = callsTo(`${TRAKT_API_URL}/sync/history`).find(
      (call) => call[1]?.method === "POST",
    );
    const payload = bodyOf(addCall);

    expect(payload.shows[0].ids.imdb).toBe("tt0903747");
    expect(payload.shows[1].ids.mal).toBe(16498);
    expect(payload.movies[0].ids.tmdb).toBe(27205);
  });
});

describe("sync flow — history removal", () => {
  it("removes previous history when requested", async () => {
    setupDefaultMocks(
      { ...DEFAULT_CONFIG, remove_previous: true },
      {
        movies: [{ movie: { ids: { tmdb: 1 } } }],
        shows: [{ show: { ids: { tmdb: 2 } } }],
        removeResult: { deleted: { movies: 1, episodes: 5 } },
      },
    );

    await sync();

    expect(callsTo(`${TRAKT_API_URL}/sync/watched/movies`)).toHaveLength(1);
    expect(callsTo(`${TRAKT_API_URL}/sync/watched/shows`)).toHaveLength(1);
    expect(bodyOf(callsTo(`${TRAKT_API_URL}/sync/history/remove`)[0])).toEqual({
      movies: [{ ids: { tmdb: 1 } }],
      shows: [{ ids: { tmdb: 2 } }],
    });
    expect(
      callsTo(`${TRAKT_API_URL}/sync/history`).filter(
        (call) => call[1]?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("continues syncing when history removal fails and user confirms", async () => {
    setupDefaultMocks({ ...DEFAULT_CONFIG, remove_previous: true });

    fetch.mockImplementation(async (url, options = {}) => {
      if (url === `${TRAKT_API_URL}/sync/watched/movies`) {
        return jsonResponse(429, {});
      }
      if (url.includes("/oauth/pin?client_id=")) {
        return jsonResponse(200, {
          user_code: "SIMKL_PIN",
          verification_url: "https://simkl.com/pin",
        });
      }
      if (url.includes("/oauth/pin/SIMKL_PIN")) {
        return jsonResponse(200, { access_token: "simkl_token_123" });
      }
      if (url.includes("/sync/all-items")) {
        return jsonResponse(200, SIMKL_WATCH_DATA);
      }
      if (url === `${TRAKT_AUTH_URL}/oauth/device/code`) {
        return jsonResponse(200, TRAKT_DEVICE);
      }
      if (url === `${TRAKT_AUTH_URL}/oauth/device/token`) {
        return jsonResponse(200, { access_token: "trakt_token" });
      }
      if (url === `${TRAKT_API_URL}/sync/history` && options.method === "POST") {
        return jsonResponse(200, { added: { movies: 1, episodes: 2 } });
      }
      return jsonResponse(404, {});
    });

    p.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await sync();

    expect(p.log.warning).toHaveBeenCalledWith(
      expect.stringContaining("429"),
    );
    expect(
      callsTo(`${TRAKT_API_URL}/sync/history`).filter(
        (call) => call[1]?.method === "POST",
      ),
    ).toHaveLength(1);
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
    setupDefaultMocks(DEFAULT_CONFIG, { deviceCodeStatus: 401 });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("401"),
    );
  });

  it("exits when the Trakt device code expires", async () => {
    setupDefaultMocks(DEFAULT_CONFIG, {
      device: { ...TRAKT_DEVICE, expires_in: 0 },
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith("Authorization expired.");
  });

  it("exits on Trakt history sync failure", async () => {
    setupDefaultMocks();
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    fetch.mockImplementation(async (url, options = {}) => {
      if (url === `${TRAKT_API_URL}/sync/history` && options.method === "POST") {
        return jsonResponse(429, {});
      }
      if (url.includes("/oauth/pin?client_id=")) {
        return jsonResponse(200, {
          user_code: "SIMKL_PIN",
          verification_url: "https://simkl.com/pin",
        });
      }
      if (url.includes("/oauth/pin/SIMKL_PIN")) {
        return jsonResponse(200, { access_token: "simkl_token_123" });
      }
      if (url.includes("/sync/all-items")) {
        return jsonResponse(200, SIMKL_WATCH_DATA);
      }
      if (url === `${TRAKT_AUTH_URL}/oauth/device/code`) {
        return jsonResponse(200, TRAKT_DEVICE);
      }
      if (url === `${TRAKT_AUTH_URL}/oauth/device/token`) {
        return jsonResponse(200, { access_token: "trakt_token" });
      }
      return jsonResponse(404, {});
    });

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("429"),
    );
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
  function postedHistory() {
    const addCall = callsTo(`${TRAKT_API_URL}/sync/history`).find(
      (call) => call[1]?.method === "POST",
    );
    return bodyOf(addCall);
  }

  it("handles watch history with no anime", async () => {
    setupDefaultMocks(DEFAULT_CONFIG, {
      simklData: { ...SIMKL_WATCH_DATA, anime: [] },
    });

    await sync();

    const payload = postedHistory();
    expect(payload.shows).toHaveLength(1);
    expect(payload.movies).toHaveLength(1);
  });

  it("handles watch history with only movies", async () => {
    setupDefaultMocks(DEFAULT_CONFIG, {
      simklData: { shows: [], anime: [], movies: SIMKL_WATCH_DATA.movies },
    });

    await sync();

    const payload = postedHistory();
    expect(payload.shows).toHaveLength(0);
    expect(payload.movies).toHaveLength(1);
  });
});

describe("safeSpinner", () => {
  it("delegates start and stop to the underlying spinner", () => {
    const s = safeSpinner();

    s.start("loading");
    expect(mockSpinner.start).toHaveBeenCalledWith("loading");

    s.stop("done");
    expect(mockSpinner.stop).toHaveBeenCalledWith("done");
  });

  it("does not call underlying stop when spinner was never started", () => {
    const s = safeSpinner();

    s.stop("should be ignored");
    expect(mockSpinner.stop).not.toHaveBeenCalled();
  });

  it("does not call underlying stop twice on double-stop", () => {
    const s = safeSpinner();

    s.start("loading");
    s.stop("first stop");
    s.stop("second stop");

    expect(mockSpinner.stop).toHaveBeenCalledTimes(1);
    expect(mockSpinner.stop).toHaveBeenCalledWith("first stop");
  });

  it("allows restart after stop", () => {
    const s = safeSpinner();

    s.start("phase 1");
    s.stop("done 1");
    s.start("phase 2");
    s.stop("done 2");

    expect(mockSpinner.start).toHaveBeenCalledTimes(2);
    expect(mockSpinner.stop).toHaveBeenCalledTimes(2);
  });
});

describe("sync flow — spinner safety (Issue #1)", () => {
  it("does not crash when Trakt device code fails before spinner starts", async () => {
    setupDefaultMocks(DEFAULT_CONFIG, { deviceCodeStatus: 401 });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    await expect(sync()).rejects.toThrow("EXIT_1");
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("401"),
    );

    const stopCalls = mockSpinner.stop.mock.calls.map((c) => c[0]);
    expect(stopCalls).not.toContain("Trakt auth failed");
  });

  it("does not crash when error occurs between Simkl stop and restart", async () => {
    setupDefaultMocks();
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });

    p.confirm.mockRejectedValueOnce(new Error("Prompt error"));

    await expect(sync()).rejects.toThrow("EXIT_1");
  });
});

describe("sync flow — Trakt sign-in without a client secret", () => {
  it("does not ask for or send a Trakt client secret", async () => {
    setupDefaultMocks();

    await sync();

    expect(p.group.mock.calls[0][0]).not.toHaveProperty("client_secret");

    const tokenCall = fetch.mock.calls.find((call) =>
      String(call[0]).includes("/oauth/device/token"),
    );
    expect(tokenCall).toBeDefined();
    const body = JSON.parse(tokenCall[1].body);
    expect(body.client_id).toBe("test-trakt-id");
    expect(body).not.toHaveProperty("client_secret");
  });
});

describe("sync flow — single payload computation (Issue #2)", () => {
  it("calls buildSyncPayload only once for both display and sync", async () => {
    setupDefaultMocks();

    await sync();

    const addCall = callsTo(`${TRAKT_API_URL}/sync/history`).find(
      (call) => call[1]?.method === "POST",
    );
    const addPayload = bodyOf(addCall);
    expect(addPayload.shows).toHaveLength(2);
    expect(addPayload.movies).toHaveLength(1);

    const syncStartMsg = mockSpinner.start.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("Syncing"),
    );
    expect(syncStartMsg).toBeDefined();
    expect(syncStartMsg[0]).toContain("2");
    expect(syncStartMsg[0]).toContain("1");
  });
});
