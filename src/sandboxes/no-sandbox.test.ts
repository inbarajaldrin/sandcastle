import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { noSandbox } from "./no-sandbox.js";

/** Is the cgroup-v2 reap path (systemd-run --user --scope) available on this host? */
function cgroupReapAvailable(): boolean {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR)
    return false;
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return false;
  try {
    execFileSync("sh", ["-c", "command -v systemd-run >/dev/null 2>&1"]);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` no longer exists (signal-0 probe → ESRCH), or time out. Event-based, not a blind sleep. */
async function waitUntilGone(pid: number, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — reaped
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const pidFromLines = (lines: string[], tag: string): number => {
  const line = lines.find((l) => l.includes(`${tag}=`));
  const m = line?.match(new RegExp(`${tag}=(\\d+)`));
  if (!m) throw new Error(`no ${tag}= line in: ${JSON.stringify(lines)}`);
  return Number(m[1]);
};

describe("noSandbox", () => {
  it("returns a provider with tag 'none'", () => {
    const provider = noSandbox();
    expect(provider.tag).toBe("none");
    expect(provider.name).toBe("no-sandbox");
    expect(provider.env).toEqual({});
  });

  it("merges env from options", () => {
    const provider = noSandbox({ env: { FOO: "bar" } });
    expect(provider.env).toEqual({ FOO: "bar" });
  });

  describe("handle", () => {
    it("exec runs a command on the host and returns output", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec('echo "hello world"');
      expect(result.stdout).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("exec returns non-zero exit code on failure", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("exec supports onLine streaming callback", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const lines: string[] = [];
      const result = await handle.exec('echo "line1"; echo "line2"', {
        onLine: (line) => lines.push(line),
      });

      expect(lines).toEqual(["line1", "line2"]);
      expect(result.stdout).toContain("line1");
      expect(result.exitCode).toBe(0);
    });

    it("exec respects cwd option", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: "/tmp",
        env: {},
      });

      const result = await handle.exec("pwd", { cwd: "/tmp" });
      expect(result.stdout.trim()).toBe("/tmp");
    });

    it("exec ignores sudo option (no-op)", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // sudo is a no-op — the command should still run successfully
      const result = await handle.exec('echo "test"', { sudo: true });
      expect(result.stdout).toContain("test");
      expect(result.exitCode).toBe(0);
    });

    it("exec passes env vars to spawned processes", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: { MY_TEST_VAR: "sandcastle_test_value" },
      });

      const result = await handle.exec("echo $MY_TEST_VAR");
      expect(result.stdout.trim()).toBe("sandcastle_test_value");
    });

    it("interactiveExec spawns process and returns exit code", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const result = await handle.interactiveExec(["sh", "-c", "exit 0"], {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });

      expect(result.exitCode).toBe(0);
    });

    it("bounds streamed stdout to the configured tail without dropping live lines", async () => {
      const provider = noSandbox({ maxOutputTailChars: 100 });
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const lines: string[] = [];
      const result = await handle.exec(
        'for i in $(seq 1 5000); do echo "line-$i"; done',
        { onLine: (line) => lines.push(line) },
      );

      // The process survives and exits cleanly — no RangeError crash.
      expect(result.exitCode).toBe(0);
      // Every line is delivered live to onLine, regardless of the tail bound.
      expect(lines.length).toBe(5000);
      expect(lines[0]).toBe("line-1");
      expect(lines[lines.length - 1]).toBe("line-5000");
      // The returned stdout is bounded to the configured tail.
      expect(result.stdout.length).toBeLessThanOrEqual(100);
      // ...and it is the tail, so the most recent line is present.
      expect(result.stdout).toContain("line-5000");
    });

    it("bounds streamed stderr to the configured tail", async () => {
      const provider = noSandbox({ maxOutputTailChars: 100 });
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      // onLine selects the streaming branch; stderr is accumulated there too.
      const result = await handle.exec(
        'for i in $(seq 1 5000); do echo "err-$i" >&2; done',
        { onLine: () => {} },
      );

      expect(result.exitCode).toBe(0);
      // The returned stderr is bounded to the configured tail...
      expect(result.stderr.length).toBeLessThanOrEqual(100);
      // ...and it is the tail, so the most recent output is present.
      expect(result.stderr).toContain("err-5000");
    });

    it("close is a no-op and does not throw", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      await expect(handle.close()).resolves.toBeUndefined();
    });
  });

  // ── orphan reaping ─────────────────────────────────────────────────────────
  // Children the agent backgrounds must not outlive the run. These spawn real
  // processes and observe the real reap signal (pid gone), with a short grace.
  describe("reaping", () => {
    const prevGrace = process.env.SC_REAP_GRACE_S;
    beforeAll(() => {
      process.env.SC_REAP_GRACE_S = "1"; // dial the TERM→KILL grace down for tests
    });
    afterAll(() => {
      if (prevGrace === undefined) delete process.env.SC_REAP_GRACE_S;
      else process.env.SC_REAP_GRACE_S = prevGrace;
    });

    it("sweeps a backgrounded (&) child left behind after a clean exit", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const lines: string[] = [];
      // Background a long sleep, print its PID, then exit cleanly.
      const result = await handle.exec('sleep 120 & echo "BG=$!"; exit 0', {
        onLine: (l) => lines.push(l),
      });
      expect(result.exitCode).toBe(0);

      const bg = pidFromLines(lines, "BG");
      // The agent exited, but the backgrounded child must be reaped (not leaked).
      expect(await waitUntilGone(bg)).toBe(true);
    });

    it("reaps the whole tree when the run is aborted mid-flight", async () => {
      const provider = noSandbox();
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });

      const ac = new AbortController();
      const lines: string[] = [];
      // Foreground sleep keeps the run alive; a backgrounded sleep is the orphan risk.
      const execPromise = handle.exec(
        'sleep 120 & echo "BG=$!"; echo "READY"; sleep 120',
        { onLine: (l) => lines.push(l), signal: ac.signal },
      );
      // Wait for the run to be up (READY printed) before aborting — event-based.
      const start = Date.now();
      while (!lines.includes("READY") && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(lines).toContain("READY");
      const bg = pidFromLines(lines, "BG");

      ac.abort("test abort");
      const result = await execPromise;

      // Reaped runs surface a loud, attributable, non-zero result (fail-loud).
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("[no-sandbox reaper]");
      // ...and the backgrounded child is actually gone.
      expect(await waitUntilGone(bg)).toBe(true);
    });

    it.runIf(cgroupReapAvailable())(
      "reaps a setsid escapee (own session — would survive killpg) via the cgroup",
      async () => {
        const provider = noSandbox();
        const handle = await provider.create({
          worktreePath: process.cwd(),
          env: {},
        });

        const ac = new AbortController();
        const lines: string[] = [];
        // setsid => the child is its own session/group leader and ESCAPES any
        // process-group kill. Only cgroup reaping catches it.
        const execPromise = handle.exec(
          'setsid sleep 120 & sleep 0.3; echo "ESC=$(pgrep -n -f \'sleep 120\')"; echo "READY"; sleep 120',
          { onLine: (l) => lines.push(l), signal: ac.signal },
        );
        const start = Date.now();
        while (!lines.includes("READY") && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(lines).toContain("READY");
        const esc = pidFromLines(lines, "ESC");

        ac.abort("test abort");
        await execPromise;

        expect(await waitUntilGone(esc)).toBe(true);
      },
    );
  });
});
