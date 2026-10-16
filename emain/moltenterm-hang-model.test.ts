// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { SlowSyncIpcChannel, timedSendSync } from "./moltenterm-hang-ipc";
import {
    HangEventLog,
    HangPingMs,
    HangStallMs,
    HangWatchModel,
    MainLagLogMs,
    shouldNotifyStall,
} from "./moltenterm-hang-model";

// Drives the model as Electron main's timer would, every HangPingMs, answering the pings while the page is free.
function run(model: HangWatchModel, from: number, to: number, answers: (now: number) => boolean) {
    const stalls: number[] = [];
    const recovered: number[] = [];
    for (let now = from; now <= to; now += HangPingMs) {
        const result = model.tick(now, [7]);
        stalls.push(...result.stalled.map((s) => s.ms));
        for (const ping of result.ping) {
            if (answers(now)) {
                const { stalledMs } = model.pong(ping.id, ping.seq, now);
                if (stalledMs > 0) recovered.push(stalledMs);
            }
        }
    }
    return { stalls, recovered };
}

describe("hang watch (#849)", () => {
    it("reports nothing while the page answers every ping", () => {
        const model = new HangWatchModel();
        const { stalls, recovered } = run(model, 1000, 20000, () => true);
        expect(stalls).toEqual([]);
        expect(recovered).toEqual([]);
    });

    it("reports a page blocked 5 s once as unresponsive, then how long it was silent, enough to notify (AC1)", () => {
        const model = new HangWatchModel();
        let pending: { seq: number } = null;
        const stalls: number[] = [];
        let recovered = 0;
        for (let now = 1000; now <= 12000; now += HangPingMs) {
            const blocked = now > 3000 && now < 8000;
            const result = model.tick(now, [7]);
            stalls.push(...result.stalled.map((s) => s.ms));
            if (result.ping.length > 0) pending = { seq: result.ping[0].seq };
            if (!blocked && pending != null) {
                const answer = model.pong(7, pending.seq, now);
                pending = null;
                if (answer.stalledMs > 0) recovered = answer.stalledMs;
            }
        }
        expect(stalls).toHaveLength(1);
        expect(stalls[0]).toBeGreaterThanOrEqual(HangStallMs);
        expect(recovered).toBeGreaterThanOrEqual(5000);
        expect(shouldNotifyStall(recovered)).toBe(true);
    });

    it("does not blame the page when Electron main itself was late (blocked, or the system slept)", () => {
        const model = new HangWatchModel();
        model.tick(1000, [7]);
        const late = model.tick(1000 + HangPingMs + MainLagLogMs + 4000, [7]);
        expect(late.mainLagMs).toBeGreaterThanOrEqual(MainLagLogMs);
        expect(late.stalled).toEqual([]);
        expect(late.ping).toHaveLength(1);
    });

    it("forgets a page that stopped being watched, and ignores answers to an old ping", () => {
        const model = new HangWatchModel();
        const first = model.tick(1000, [7]);
        model.tick(1500, []);
        expect(model.targets.size).toBe(0);
        expect(model.pong(7, first.ping[0].seq, 1600)).toEqual({ stalledMs: 0 });
    });

    it("pauses during system sleep", () => {
        const model = new HangWatchModel();
        model.tick(1000, [7]);
        model.pause();
        expect(model.tick(60000, [7])).toEqual({ ping: [], stalled: [], mainLagMs: 0 });
        model.resume();
        const after = model.tick(61000, [7]);
        expect(after.mainLagMs).toBe(0);
        expect(after.stalled).toEqual([]);
    });

    it("keeps only the recent events", () => {
        const log = new HangEventLog(3);
        ["a", "b", "c", "d"].forEach((l) => log.add(l));
        expect(log.recent()).toEqual(["b", "c", "d"]);
    });
});

describe("timed sendSync (#849)", () => {
    it("reports a round trip of at least the limit, with its channel, and returns the value", () => {
        const ipc = { sendSync: vi.fn(() => "v"), send: vi.fn() };
        let clock = 0;
        ipc.sendSync.mockImplementation(() => {
            clock += 1500;
            return "v";
        });
        expect(timedSendSync(ipc, 1000, () => clock, "get-env", "HOME")).toBe("v");
        expect(ipc.sendSync).toHaveBeenCalledWith("get-env", "HOME");
        expect(ipc.send).toHaveBeenCalledWith(SlowSyncIpcChannel, "get-env", 1500);
    });

    it("stays quiet for a quick one", () => {
        const ipc = { sendSync: vi.fn(() => 1), send: vi.fn() };
        timedSendSync(ipc, 1000, () => 0, "get-zoom-factor");
        expect(ipc.send).not.toHaveBeenCalled();
    });
});
