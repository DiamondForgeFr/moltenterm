// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = { allowed: true };
const listeners = new Set<(answer: any) => void>();
const rpc = { open: false };
const model = { start: vi.fn(), onAnswer: vi.fn(), forget: vi.fn(), refresh: vi.fn() };

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { wshRpcCall: async () => ({ allowed: true, open: rpc.open, version: 1 }) },
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
    Object.values(model).forEach((fn) => fn.mockClear());
    rpc.open = false;
    gate.allowed = true;
});

// FR-BOSS-011 AC3, AC6: the layer stops the watch when the developer switches the brainstorm off and starts it again when
// the switch is back on, without a restart.
describe("the brainstorm's watch follows the developer's switch", () => {
    it("watches again after the layer stopped it", async () => {
        const boot = await import("./brainstorm-boot");
        const stop = boot.bootBrainstorm();
        expect(listeners.size).toBe(1);
        stop();
        expect(listeners.size).toBe(0);
        boot.bootBrainstorm();
        expect(listeners.size).toBe(1);
    });

    it("watches nothing while it is off, and watches once it is on", async () => {
        gate.allowed = false;
        const boot = await import("./brainstorm-boot");
        boot.bootBrainstorm()();
        expect(listeners.size).toBe(0);
        gate.allowed = true;
        boot.bootBrainstorm();
        expect(listeners.size).toBe(1);
    });

    it("watches once in a view that asks twice", async () => {
        const boot = await import("./brainstorm-boot");
        boot.bootBrainstorm();
        boot.bootBrainstorm();
        expect(listeners.size).toBe(1);
    });
});

// The mode is wavesrv's and wavesrv refuses a brainstorm that is switched off: a view cannot be told that it ended, so it
// lets go of it through its model, whichever window turned the switch.
describe("a view lets go of the mode when the brainstorm is switched off", () => {
    it("lets the model release what the mode held, once the model is loaded", async () => {
        const boot = await import("./brainstorm-boot");
        const { globalStore } = await import("@/app/store/jotaiStore");
        await boot.loadBrainstorm();
        globalStore.set(boot.BrainstormStateAtom, { allowed: true, open: true, version: 1 });
        boot.forgetBrainstorm();
        expect(model.forget).toHaveBeenCalledTimes(1);
    });

    it("forgets the state itself where the model never loaded, so nothing is held", async () => {
        const boot = await import("./brainstorm-boot");
        const { globalStore } = await import("@/app/store/jotaiStore");
        globalStore.set(boot.BrainstormStateAtom, { allowed: true, open: true, version: 1 });
        boot.forgetBrainstorm();
        expect(globalStore.get(boot.BrainstormStateAtom)).toBeNull();
        expect(model.forget).not.toHaveBeenCalled();
    });
});

// The mode may still be on in wavesrv when the switch comes back (it could not be ended, or another window started one): a
// view that watches again reads it, since the model loaded before does not look by itself.
describe("a view that watches again reads wavesrv's state", () => {
    it("refreshes the model it loaded before, when the mode is on", async () => {
        const boot = await import("./brainstorm-boot");
        const stop = boot.bootBrainstorm();
        await boot.loadBrainstorm();
        stop();
        expect(model.start).toHaveBeenCalledTimes(1);
        rpc.open = true;
        boot.bootBrainstorm();
        await settle();
        expect(model.refresh).toHaveBeenCalledTimes(1);
        expect(model.start).toHaveBeenCalledTimes(1);
    });

    it("does not read it twice when the first wake loads the model, which reads it as it starts", async () => {
        rpc.open = true;
        const boot = await import("./brainstorm-boot");
        boot.bootBrainstorm();
        await settle();
        expect(model.start).toHaveBeenCalledTimes(1);
        expect(model.refresh).not.toHaveBeenCalled();
    });

    it("leaves the model alone when the mode is off", async () => {
        const boot = await import("./brainstorm-boot");
        const stop = boot.bootBrainstorm();
        await boot.loadBrainstorm();
        stop();
        boot.bootBrainstorm();
        await settle();
        expect(model.refresh).not.toHaveBeenCalled();
    });
});
