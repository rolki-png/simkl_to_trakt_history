import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENTRY = join(ROOT, "sync.mjs");

const stripAnsi = (str) =>
  str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");

function run(args = [], options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      [ENTRY, ...args],
      {
        cwd: ROOT,
        timeout: options.timeout ?? 5000,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          exitCode: error?.code ?? 0,
          killed: error?.killed ?? false,
        });
      },
    );

    if (options.closeStdin !== false) {
      child.stdin?.end();
    }
  });
}

describe("CLI integration", () => {
  it("prints help with --help", async () => {
    const { stdout, exitCode } = await run(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("simkl-to-trakt");
    expect(stdout).toContain("Transfer your Simkl watch history to Trakt.tv");
    expect(stdout).toContain("sync");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("--help");
  });

  it("prints version with --version", async () => {
    const { stdout, exitCode } = await run(["--version"]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("1.0.1");
  });

  it("prints sync subcommand help with sync --help", async () => {
    const { stdout, exitCode } = await run(["sync", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Start the sync wizard");
  });

  it("starts sync wizard by default (no subcommand)", async () => {
    const { stdout } = await run([], { timeout: 3000 });

    expect(stdout).toContain("simkl");
    expect(stdout).toContain("trakt");
  });

  it("shows version number consistent with package.json", async () => {
    const { stdout } = await run(["--version"]);
    const { version } = await import("../package.json", {
      with: { type: "json" },
    });

    expect(stdout.trim()).toBe(version);
  });
});
