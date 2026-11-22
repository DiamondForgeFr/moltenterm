// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as pause } from "node:timers/promises";

// Normally drain the owned group before cleanup; OS failure aborts and revokes owned credentials best-effort.
// Raw builder output is deliberately not forwarded: upstream errors/debug output can contain credentials.
// With `capture`, the output is read into a bounded in-memory tail only so the caller can map it to a fixed label: it
// is attached to a failure as the non-enumerable `output` property, and the caller must drop it after classifying.
export const CaptureLimit = 64 * 1024;
const StreamSettleMs = 1000;

export async function runOwnedProcess(
    file,
    args,
    {
        env,
        cwd,
        signal,
        capture = false,
        start = spawn,
        kill = process.kill.bind(process),
        wait = pause,
        now = performance.now.bind(performance),
        graceMs = 5000,
        killWaitMs = 5000,
    } = {}
) {
    if (signal?.aborted) throw new Error("Signing packaging interrupted");
    let child;
    try {
        child = start(file, args, {
            env,
            cwd,
            detached: true,
            stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
        });
    } catch {
        throw new Error("Signing packaging could not start");
    }
    let code,
        failed = false,
        aborted = false,
        parentClosed = false,
        tail = "",
        stop;
    const streams = capture ? [child.stdout, child.stderr].filter(Boolean) : [];
    const streamsEnded = Promise.all(
        streams.map(
            (stream) =>
                new Promise((resolve) => {
                    stream.setEncoding?.("utf8");
                    stream.on("data", (chunk) => {
                        tail = (tail + chunk).slice(-CaptureLimit);
                    });
                    stream.once("close", resolve);
                    stream.once("error", resolve);
                })
        )
    );
    const closed = new Promise((resolve) => {
        child.once("error", () => {
            failed = true;
            parentClosed = true;
            resolve();
        });
        // A descendant holding the pipes open must not keep a finished parent from being drained and killed.
        child.once(capture ? "exit" : "close", (exitCode) => {
            code = exitCode;
            parentClosed = true;
            resolve();
        });
    });
    let rejectDrain;
    const drainFailed = new Promise((_, reject) => {
        rejectDrain = reject;
    });
    const processComplete = Promise.race([closed, drainFailed]);
    const groupExists = () => {
        try {
            kill(-child.pid, 0);
            return true;
        } catch (error) {
            if (error.code === "ESRCH") return false;
            // A transient probe/kill error cannot authorize early key cleanup.
            failed = true;
            return true;
        }
    };
    const stopAndDrain = () =>
        (stop ??= (async () => {
            if (!Number.isInteger(child.pid) || child.pid <= 1) {
                failed = true;
                rejectDrain(new Error("Signing packaging process cleanup failed"));
                return;
            }
            const began = now();
            const send = (name) => {
                try {
                    kill(-child.pid, name);
                } catch (error) {
                    if (error.code !== "ESRCH") failed = true;
                }
            };
            if (groupExists()) send("SIGTERM");
            let forceSent = false;
            while (true) {
                const alive = groupExists();
                if (!alive && parentClosed) return;
                if (!forceSent && now() - began >= graceMs) {
                    forceSent = true;
                    if (alive) send("SIGKILL");
                }
                if (now() - began >= graceMs + killWaitMs) {
                    failed = true;
                    // OS failure is not success. Let the enclosing session revoke its owned credentials best-effort.
                    rejectDrain(new Error("Signing packaging process cleanup failed"));
                    return;
                }
                // Normally wait for the OS to reap the group; a sent signal alone is not evidence of exit.
                await wait(50);
            }
        })().catch(() => {
            failed = true;
            rejectDrain(new Error("Signing packaging process cleanup failed"));
        }));
    const onAbort = () => {
        aborted = true;
        void stopAndDrain();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
        await processComplete;
        if (Number.isInteger(child.pid) && child.pid > 1) {
            if (!stop && groupExists()) {
                failed = true;
                await stopAndDrain();
            }
            if (stop) await stop;
        }
        if (aborted || signal?.aborted) throw new Error("Signing packaging interrupted");
        if (failed || code !== 0) throw new Error("Signing packaging failed");
    } catch {
        const error = new Error(
            aborted ? "Signing packaging interrupted or process cleanup failed" : "Signing packaging failed"
        );
        if (capture && !aborted) {
            // The group is gone by now, so its pipes end at once; the cap only bounds a stuck stream.
            await Promise.race([streamsEnded, pause(StreamSettleMs)]);
            Object.defineProperty(error, "output", { value: tail, enumerable: false, configurable: true });
        }
        throw error;
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}
