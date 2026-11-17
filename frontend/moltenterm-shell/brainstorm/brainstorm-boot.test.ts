// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = { allowed: true };
const model = { start: vi.fn(), onAnswer: vi.fn(), begin: vi.fn() };
const listeners = new Set<(answer: any) => void>();
const rpc = { open: false, calls: 0 };

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: async () => {
            rpc.calls++;
            return { allowed: true, open: rpc.open, version: 1 };
        },
    },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("../build/current-build", () => ({ currentBrainstormAllowed: () => gate.allowed }));
vi.mock("../boss/brokk-session", () => ({
    BrokkSession: {
        getInstance: () => ({
            listenAnswers: (fn: (a: any) => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
        }),
    },
}));
vi.mock("./brainstorm-store", () => ({ BrainstormModel: { getInstance: () => model } }));

// The module graph loads once while the file is collected; each test then takes a fresh copy of the watch.
import "./brainstorm-boot";

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    model.start.mockClear();
    model.onAnswer.mockClear();
    model.begin.mockClear();
    rpc.open = false;
    rpc.calls = 0;
    gate.allowed = true;
});

// FR-BOSS-010 AC19, NFR-BOSS-009 (#2246): the brainstorm loads only when it is needed.
describe("the brainstorm's watch", () => {
    it("watches nothing on a release channel", async () => {
        gate.allowed = false;
        const boot = await import("./brainstorm-boot");
        boot.bootBrainstorm();
        await boot.openBrainstorm();
        await settle();
        expect(listeners.size).toBe(0);
        expect(rpc.calls).toBe(0);
        expect(model.start).not.toHaveBeenCalled();
        expect(model.begin).not.toHaveBeenCalled();
    });

    it("leaves a plain answer alone and loads the brainstorm for a graph block, which it reads first", async () => {
        const boot = await import("./brainstorm-boot");
        boot.bootBrainstorm();
        await settle();
        expect(model.start).not.toHaveBeenCalled();
        listeners.forEach((fn) => fn({ id: "m1", you: "Time?", markdown: "Ten past two.", turn: 1, final: true }));
        await settle();
        expect(model.start).not.toHaveBeenCalled();
        const answer = { id: "m2", you: "An idea", markdown: "Go.\n\n```brokk-graph\n{}\n```", turn: 2, final: false };
        listeners.forEach((fn) => fn(answer));
        await settle();
        expect(model.start).toHaveBeenCalledTimes(1);
        expect(model.onAnswer).toHaveBeenCalledWith(answer);
        // From then on the brainstorm follows the answers itself.
        expect(listeners.size).toBe(0);
    });

    it("loads the brainstorm in a view opened while the mode is on, and for the developer's start", async () => {
        rpc.open = true;
        const boot = await import("./brainstorm-boot");
        boot.bootBrainstorm();
        await settle();
        expect(model.start).toHaveBeenCalledTimes(1);
        await boot.openBrainstorm();
        expect(model.begin).toHaveBeenCalledTimes(1);
        expect(model.start).toHaveBeenCalledTimes(1);
    });
});
