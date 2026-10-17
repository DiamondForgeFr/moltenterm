// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as pause } from "node:timers/promises";

// Normally drain the owned group before cleanup; OS failure aborts and revokes owned credentials best-effort.
// Raw builder output is deliberately not forwarded: upstream errors/debug output can contain credentials.
export async function runOwnedProcess(
    file,
    args,
    {
        env,
        cwd,
        signal,
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
        child = start(file, args, { env, cwd, detached: true, stdio: "ignore" });
    } catch {
        throw new Error("Signing packaging could not start");
    }
    let code,
        failed = false,
        aborted = false,
        parentClosed = false,
        stop;
    const closed = new Promise((resolve) => {
        child.once("error", () => {
            failed = true;
            parentClosed = true;
            resolve();
        });
        child.once("close", (exitCode) => {
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
        throw new Error(
            aborted ? "Signing packaging interrupted or process cleanup failed" : "Signing packaging failed"
        );
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}
