// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runOwnedProcess } from "./process.mjs";

function fakeProcess() {
    const child = new EventEmitter();
    child.pid = 507507;
    const observed = new EventEmitter();
    let alive = true,
        tick = 0,
        started;
    const calls = [],
        waits = [];
    return {
        child,
        calls,
        waits,
        get started() {
            return started;
        },
        whenSignal(signal) {
            return calls.includes(signal)
                ? Promise.resolve()
                : new Promise((resolve) => observed.once(signal, resolve));
        },
        setAlive(value) {
            alive = value;
        },
        start(file, args, options) {
            started = { file, args, options };
            return child;
        },
        kill(pid, signal) {
            assert.equal(pid, -507507);
            calls.push(signal);
            observed.emit(signal);
            if (!alive) {
                const error = new Error("gone");
                error.code = "ESRCH";
                throw error;
            }
        },
        now: () => tick,
        async wait(ms) {
            tick += ms;
            await new Promise((resolve) => waits.push(resolve));
        },
        release() {
            for (const resolve of waits.splice(0)) resolve();
        },
    };
}

test("successful child is isolated and its raw diagnostics have no inherited stdio", async () => {
    const fake = fakeProcess();
    const promise = runOwnedProcess("node", ["builder"], { ...fake, env: { SAFE: "value" } });
    fake.setAlive(false);
    fake.child.emit("close", 0);
    await promise;
    assert.equal(fake.started.options.detached, true);
    assert.equal(fake.started.options.stdio, "ignore");
    assert.deepEqual(fake.started.options.env, { SAFE: "value" });
    assert.ok(fake.calls.every((signal) => signal === 0));
});

test("cancellation waits for descendant group after parent close, escalates, then permits cleanup", async () => {
    const fake = fakeProcess(),
        controller = new globalThis.AbortController();
    let done = false;
    const promise = runOwnedProcess("node", [], { ...fake, signal: controller.signal, graceMs: 0 }).catch((error) => {
        done = true;
        throw error;
    });
    controller.abort();
    fake.child.emit("close", null);
    await fake.whenSignal("SIGTERM");
    assert.equal(done, false);
    assert.ok(fake.calls.includes("SIGTERM"));
    assert.ok(fake.calls.includes("SIGKILL"));
    fake.setAlive(false);
    fake.release();
    await assert.rejects(promise, /interrupted/);
    assert.equal(done, true);
});

test("a successful parent cannot leave descendants running", async () => {
    const fake = fakeProcess();
    const promise = runOwnedProcess("node", [], { ...fake, graceMs: 0 });
    fake.child.emit("close", 0);
    await fake.whenSignal("SIGTERM");
    assert.ok(fake.calls.includes("SIGTERM"));
    fake.setAlive(false);
    fake.release();
    await assert.rejects(promise, /failed/);
});

test("start errors and nonzero exits return only generic diagnostics", async () => {
    await assert.rejects(
        runOwnedProcess("node", [], {
            start() {
                throw new Error("private-key-bytes");
            },
        }),
        (error) => error.message === "Signing packaging could not start"
    );
    const fake = fakeProcess();
    const promise = runOwnedProcess("node", [], fake);
    fake.setAlive(false);
    fake.child.emit("close", 17);
    await assert.rejects(promise, (error) => error.message === "Signing packaging failed");
    const controller = new globalThis.AbortController();
    controller.abort();
    let started = false;
    await assert.rejects(
        runOwnedProcess("node", [], {
            signal: controller.signal,
            start() {
                started = true;
            },
        }),
        /interrupted/
    );
    assert.equal(started, false);
});

test("persistent probe/kill errors and stubborn groups fail within an injected deadline", async () => {
    for (const mode of ["permission", "stubborn", "parent-no-close"]) {
        const fake = fakeProcess(),
            controller = new globalThis.AbortController();
        let tick = 0,
            calls = 0;
        const promise = runOwnedProcess("node", [], {
            ...fake,
            signal: controller.signal,
            graceMs: 50,
            killWaitMs: 50,
            now: () => tick,
            wait: async (ms) => {
                tick += ms;
            },
            kill(pid, _signal) {
                calls++;
                assert.equal(pid, -507507);
                if (mode === "permission") {
                    const error = new Error("private diagnostic");
                    error.code = "EPERM";
                    throw error;
                }
                if (mode === "parent-no-close") {
                    const error = new Error("gone");
                    error.code = "ESRCH";
                    throw error;
                }
            },
        });
        controller.abort();
        // Parent deliberately never closes. Failed drain must still return so owned credentials can be revoked.
        await assert.rejects(
            promise,
            (error) => error.message === "Signing packaging interrupted or process cleanup failed"
        );
        assert.equal(tick, 100);
        assert.ok(calls < 20);
    }
});
