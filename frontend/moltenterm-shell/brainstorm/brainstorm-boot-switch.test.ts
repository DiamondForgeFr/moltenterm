// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = { allowed: true };
const listeners = new Set<(answer: any) => void>();

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { wshRpcCall: async () => ({ allowed: true, open: false, version: 1 }) },
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
vi.mock("./brainstorm-store", () => ({
    BrainstormModel: { getInstance: () => ({ start: vi.fn(), onAnswer: vi.fn() }) },
}));

// The module graph loads once while the file is collected; each test then takes a fresh copy of the watch.
import "./brainstorm-boot";

beforeEach(() => {
    vi.resetModules();
    listeners.clear();
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
