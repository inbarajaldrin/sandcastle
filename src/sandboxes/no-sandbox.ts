/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-7"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 *
 * ── ORPHAN REAPING (the host has no container teardown to clean up after) ──
 * A coding agent run on the host can background work (`pytest … &`, `nohup`,
 * `disown`, even `setsid`/double-fork daemons). With a plain `spawn("sh", …)`
 * those descendants OUTLIVE the agent: on an idle-timeout the orchestrator
 * abandons the awaited promise but nothing kills the tree, so a wedged test
 * keeps holding the GPU; even a clean exit leaks any `&` child. Process groups
 * don't help — `setsid` escapees leave the group. So each run is launched into
 * its OWN cgroup v2 (via `systemd-run --user --scope`, rootless) and reaped as a
 * cgroup: SIGTERM every member → grace (GUI procs like Gazebo/RViz clean up on
 * TERM, honouring the no-SIGKILL-on-GUI rule) → `cgroup.kill` (atomic SIGKILL of
 * everything still in the cgroup, setsid escapees included). The reap is wired to
 * the orchestrator's idle-timeout/abort (`signal`), to normal close (sweep any
 * survivors), and to SIGINT/SIGTERM (shutdown registry). Where `systemd-run
 * --user` isn't available it degrades to a detached process group + killpg
 * (best-effort; misses setsid escapees — logged). See ADR-0008 (pose6d).
 */

import { spawn, execFileSync, type StdioOptions } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
  ExecOptions,
  InteractiveExecOptions,
} from "../SandboxProvider.js";
import { registerShutdown } from "../shutdownRegistry.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

export interface NoSandboxOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
}

// ── reap configuration (env-overridable) ────────────────────────────────────
const CGROUP2_ROOT = "/sys/fs/cgroup";
/**
 * Grace between SIGTERM and the forced cgroup.kill. Generous by default so GUI
 * procs (Gazebo/RViz) get to exit on TERM before any SIGKILL. Read at reap time
 * so it can be tuned per run (and dialled down in tests).
 */
const reapGraceMs = (): number =>
  Math.max(0, Number(process.env.SC_REAP_GRACE_S ?? "15")) * 1000;
/** When set, stop at SIGTERM — never escalate to SIGKILL/cgroup.kill (TERM-only, fully GUI-safe). */
const reapNoForce = (): boolean => process.env.SC_REAP_NO_FORCE === "1";
/** Bound on how long settle waits for stdio to drain after the agent exits (a survivor holding the pipe). */
const DRAIN_TIMEOUT_MS = 2000;
/**
 * Optional PROVIDER-SIDE idle backstop. The orchestrator's idle timeout (wired via
 * `signal`) is the authoritative reap trigger; this is defence-in-depth only and is
 * OFF unless `SC_REAP_IDLE_S` is set, so there is one idle clock by default (no drift).
 */
const REAP_IDLE_MS = process.env.SC_REAP_IDLE_S
  ? Math.max(1, Number(process.env.SC_REAP_IDLE_S)) * 1000
  : 0;
/** Escape hatch: force the detached-pgroup fallback even where cgroups are available. */
const FORCE_NO_CGROUP = process.env.SC_NO_CGROUP === "1";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function cgroupV2Available(): boolean {
  try {
    return existsSync(join(CGROUP2_ROOT, "cgroup.controllers"));
  } catch {
    return false;
  }
}

let _systemdRunSupported: boolean | undefined;
/**
 * True iff we can put a run in its own rootless cgroup v2 via `systemd-run --user
 * --scope`. Verified by actually CREATING a throwaway scope once (presence on PATH
 * isn't enough — the user manager may refuse to delegate a scope), then cached.
 */
function systemdRunSupported(): boolean {
  if (FORCE_NO_CGROUP) return false;
  if (_systemdRunSupported !== undefined) return _systemdRunSupported;
  const prereqs =
    process.platform === "linux" &&
    !!process.env.XDG_RUNTIME_DIR &&
    cgroupV2Available();
  let canCreateScope = false;
  if (prereqs) {
    try {
      // A trivial transient scope: exits 0 only if the user manager places it.
      execFileSync(
        "systemd-run",
        ["--user", "--scope", "--quiet", "--collect", "true"],
        { stdio: "ignore", timeout: 10_000 },
      );
      canCreateScope = true;
    } catch {
      canCreateScope = false;
    }
  }
  _systemdRunSupported = prereqs && canCreateScope;
  return _systemdRunSupported;
}

/** Resolve a transient `--user` scope's cgroup directory (the one holding cgroup.procs/cgroup.kill). */
function scopeCgroupPath(unit: string): string | undefined {
  try {
    const rel = execFileSync(
      "systemctl",
      ["--user", "show", `${unit}.scope`, "-p", "ControlGroup", "--value"],
      { encoding: "utf8" },
    ).trim();
    if (rel) return join(CGROUP2_ROOT, rel);
  } catch {
    /* unit gone / not yet registered — caller falls back */
  }
  return undefined;
}

/** PIDs currently in a cgroup (empty on any read error / collected cgroup). */
function readCgroupProcs(cgPath: string): number[] {
  try {
    return readFileSync(join(cgPath, "cgroup.procs"), "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function termPids(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
export const noSandbox = (options?: NoSandboxOptions): NoSandboxProvider => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions): Promise<NoSandboxHandle> => {
    const worktreePath = createOptions.worktreePath;
    const processEnv = { ...process.env, ...createOptions.env };
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;

    const handle: NoSandboxHandle = {
      worktreePath,

      exec: (command: string, opts?: ExecOptions): Promise<ExecResult> => {
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;

        // Launch each run in its own cgroup v2 (rootless) so the WHOLE process
        // tree — including setsid/double-fork escapees — is reapable as a unit.
        const useCgroup = systemdRunSupported();
        const unit = useCgroup
          ? `sandcastle-run-${process.pid}-${randomBytes(4).toString("hex")}`
          : undefined;
        const spawnCmd = useCgroup ? "systemd-run" : "sh";
        const spawnArgs = useCgroup
          ? [
              "--user",
              "--scope",
              "--quiet",
              "--collect", // GC the transient unit once it's gone
              "--unit",
              unit!,
              "sh",
              "-c",
              command,
            ]
          : ["-c", command];

        return new Promise((resolve, reject) => {
          const proc = spawn(spawnCmd, spawnArgs, {
            cwd,
            env: processEnv,
            // Own process group so the fallback (no-cgroup) path can killpg, and
            // so a stray SIGINT to this group doesn't escape upward.
            detached: true,
            stdio: [
              opts?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
          });

          // ── per-run reaper state machine (idempotent) ───────────────────────
          let settled = false;
          let reaping = false;
          let reapReason: string | undefined;
          let exited = false; // leader has exited — fallback killpg is unsafe past this (reused PGID)
          let idleTimer: ReturnType<typeof setTimeout> | undefined;

          const clearIdle = () => {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = undefined;
            }
          };
          const bumpIdle = () => {
            if (!REAP_IDLE_MS) return;
            clearIdle();
            idleTimer = setTimeout(() => {
              void reap(`idle-backstop ${REAP_IDLE_MS / 1000}s`, true);
            }, REAP_IDLE_MS);
          };

          // Full graceful reap (TERM → grace → forced kill). `cause` distinguishes
          // a reap that TERMINATED the run (abort/idle → fail-loud, non-zero exit)
          // from a post-clean-exit SWEEP of leftover background children (the agent
          // already succeeded — preserve its real exit code).
          const reap = async (
            reason: string,
            cause: boolean,
          ): Promise<void> => {
            // Record the causal reason MONOTONICALLY — before the re-entry guard —
            // so a `cause=true` abort that races a `cause=false` close-sweep already
            // in flight still marks the run failed (it must not be masked as exit 0).
            if (cause) reapReason ??= reason;
            if (reaping) return;
            reaping = true;
            clearIdle();
            if (useCgroup && unit) {
              const cg = scopeCgroupPath(unit);
              if (!cg && cause) {
                // A causal reap that can't even resolve its cgroup is a real failure
                // to surface — never a silent no-op.
                console.error(
                  `[no-sandbox reaper] causal reap (${reason}) could NOT resolve cgroup for ${unit} — process tree may NOT be reaped. Operator/host check needed.`,
                );
              }
              const members = cg ? readCgroupProcs(cg) : [];
              termPids(members);
              await delay(reapGraceMs());
              if (!reapNoForce() && cg && existsSync(join(cg, "cgroup.kill"))) {
                try {
                  writeFileSync(join(cg, "cgroup.kill"), "1"); // atomic SIGKILL-all
                } catch {
                  /* cgroup already collected */
                }
              }
              // Verify-empty-or-fail-loud (a wedged D-state proc can't be reaped synchronously).
              const left = cg ? readCgroupProcs(cg) : [];
              if (left.length > 0) {
                console.error(
                  `[no-sandbox reaper] cgroup ${unit} NOT empty after reap (${reason}); remaining PIDs: ${left.join(", ")} — likely uninterruptible (D-state). Needs operator/host intervention.`,
                );
              }
              try {
                execFileSync(
                  "systemctl",
                  ["--user", "reset-failed", `${unit}.scope`],
                  {
                    stdio: "ignore",
                  },
                );
              } catch {
                /* best-effort cleanup */
              }
            } else if (proc.pid && !exited) {
              // Fallback (no cgroup): a SINGLE SIGTERM to the detached process group
              // while the leader is STILL ALIVE (`!exited`). NOT orphan-safe — misses
              // setsid escapees — and we deliberately DO NOT signal the group after
              // the leader exits (incl. a delayed SIGKILL): `-proc.pid` may then name a
              // REUSED process group, so a late kill could hit an innocent one.
              try {
                process.kill(-proc.pid, "SIGTERM");
              } catch {
                /* gone */
              }
            }
          };

          // Synchronous reap for the process-death path (SIGINT/SIGTERM to the
          // orchestrator): a signal handler cannot await a grace window. On the
          // cgroup path we write cgroup.kill (reliable — TERM-ignoring children
          // would otherwise be orphaned, the exact leak we fix), unless TERM-only
          // is opted in. Fallback TERMs the group best-effort.
          const reapSync = () => {
            if (useCgroup && unit) {
              const cg = scopeCgroupPath(unit);
              if (!cg) return;
              if (!reapNoForce() && existsSync(join(cg, "cgroup.kill"))) {
                try {
                  writeFileSync(join(cg, "cgroup.kill"), "1");
                } catch {
                  /* already collected */
                }
              } else {
                termPids(readCgroupProcs(cg));
              }
            } else if (proc.pid) {
              try {
                process.kill(-proc.pid, "SIGTERM");
              } catch {
                /* gone */
              }
            }
          };
          const unregisterShutdown = registerShutdown(reapSync);

          // Sweep any background survivors after a NORMAL exit. Fast path: if the
          // cgroup is already empty (the common clean case) just GC the unit — no
          // grace latency. Only reap if the agent left children behind. (The
          // no-cgroup fallback cannot sweep post-exit safely — the leader is gone
          // and -pid may be a reused group — so it does nothing here, by design.)
          const sweepOnClose = () => {
            if (reaping || !(useCgroup && unit)) return;
            const cg = scopeCgroupPath(unit);
            const survivors = (cg ? readCgroupProcs(cg) : []).filter(
              (p) => p !== proc.pid,
            );
            if (survivors.length === 0) {
              try {
                execFileSync(
                  "systemctl",
                  ["--user", "reset-failed", `${unit}.scope`],
                  { stdio: "ignore" },
                );
              } catch {
                /* nothing to clean */
              }
              return;
            }
            console.error(
              `[no-sandbox reaper] agent exited leaving ${survivors.length} background proc(s) in ${unit}: ${survivors.join(", ")} — reaping.`,
            );
            void reap(
              `close-sweep: ${survivors.length} survivor(s)`,
              false,
            ).catch(() => {});
          };

          // Orchestrator-driven cancellation (idle timeout / SIGINT) → authoritative
          // reap. Hold the handler ref so it can be removed on a normal settle —
          // otherwise a reused parent signal accumulates listeners across runs.
          let removeAbortListener = () => {};
          if (opts?.signal) {
            const sig = opts.signal;
            if (sig.aborted) {
              void reap(
                `aborted-before-start: ${String(sig.reason ?? "")}`,
                true,
              ).catch(() => {});
            } else {
              const onAbort = () =>
                void reap(`abort: ${String(sig.reason ?? "")}`, true).catch(
                  () => {},
                );
              sig.addEventListener("abort", onAbort, { once: true });
              removeAbortListener = () =>
                sig.removeEventListener("abort", onAbort);
            }
          }

          if (opts?.stdin !== undefined) {
            proc.stdin!.write(opts.stdin);
            proc.stdin!.end();
          }

          proc.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearIdle();
            removeAbortListener();
            unregisterShutdown();
            reject(new Error(`exec failed: ${error.message}`));
          });

          // Annotate the result when WE reaped the run, so the orchestrator
          // surfaces a loud, attributable failure rather than a silent abandon.
          const finalize = (
            stdout: string,
            stderr: string,
            code: number | null,
          ): ExecResult => {
            if (reapReason) {
              const note = `\n[no-sandbox reaper] run reaped (${reapReason}); process tree terminated.`;
              return {
                stdout,
                stderr: stderr + note,
                exitCode: code && code !== 0 ? code : 137,
              };
            }
            return { stdout, stderr, exitCode: code ?? 0 };
          };

          bumpIdle();

          // Capture output per streaming mode; the exit/close handlers are shared.
          let getOutput: () => { stdout: string; stderr: string };
          if (opts?.onLine) {
            const onLine = opts.onLine;
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              bumpIdle(); // activity resets the backstop
              stdoutTail.push(line);
              onLine(line);
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrTail.push(chunk.toString());
            });
            getOutput = () => ({
              stdout: stdoutTail.toString(),
              stderr: stderrTail.toString(),
            });
          } else {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            proc.stdout!.on("data", (chunk: Buffer) => {
              stdoutChunks.push(chunk.toString());
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });
            getOutput = () => ({
              stdout: stdoutChunks.join(""),
              stderr: stderrChunks.join(""),
            });
          }

          let exitCode: number | null = null;
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearIdle();
            if (drainTimer) clearTimeout(drainTimer);
            removeAbortListener();
            unregisterShutdown();
            const { stdout, stderr } = getOutput();
            resolve(finalize(stdout, stderr, exitCode));
          };

          // 'close' (all stdio flushed) is the CORRECT settle point — it guarantees
          // every 'data'/'line' event (incl. the agent's final stream-json result)
          // has arrived. We do NOT settle on 'exit' alone: data can still be queued
          // when 'exit' fires. BUT a child the agent backgrounded inherits the stdout
          // pipe and holds it open, so 'close' can lag by the child's whole lifetime.
          // So on 'exit' we (a) reap survivors — which releases the pipe so 'close'
          // arrives promptly — and (b) arm a bounded drain fallback, so even a
          // TERM-ignoring survivor (with forced-kill opted out) can't hang us forever.
          proc.on("exit", (code) => {
            exited = true; // past here, fallback killpg on -proc.pid is reuse-unsafe
            exitCode = code;
            sweepOnClose();
            drainTimer = setTimeout(settle, DRAIN_TIMEOUT_MS);
          });
          proc.on("close", (code) => {
            if (exitCode === null) exitCode = code;
            settle();
          });
        });
      },

      interactiveExec: (
        args: string[],
        opts: InteractiveExecOptions,
      ): Promise<{ exitCode: number }> => {
        return new Promise((resolve, reject) => {
          const [cmd, ...rest] = args;
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
          });

          proc.on("error", (error: Error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on("close", (code: number | null) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },

      close: async (): Promise<void> => {
        // No-op — no container to tear down
      },
    };

    return handle;
  },
});
