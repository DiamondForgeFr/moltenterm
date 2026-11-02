// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
    hangListener: null as (hang: { ms: number; at: number }) => void,
    reloadedListener: null as (notice: { reason: string; signal: string; at: number }) => void,
    logShown: 0,
    copied: [] as string[],
}));

vi.mock("@/app/store/global", () => ({
    getFocusedBlockId: () => null as string,
    getApi: () => ({
        sendLog: () => {},
        onMoltentermWindowHang: (cb: (hang: { ms: number; at: number }) => void) => {
            env.hangListener = cb;
            return () => {};
        },
        onMoltentermWindowReloaded: (cb: (notice: { reason: string; signal: string; at: number }) => void) => {
            env.reloadedListener = cb;
            return () => {};
        },
        moltentermShowLog: async () => {
            env.logShown++;
        },
        moltentermHangDiagnostics: async () => ({
            version: "1.0.0-4",
            buildtime: 1,
            uptimesec: 2,
            events: ["2026-10-16T22:57:11Z tab contents 3 unresponsive: no answer for 2000 ms"],
        }),
    }),
}));
vi.mock("@/app/store/wos", () => ({ getObjectValue: () => null as any, makeORef: (t: string, id: string) => t + id }));

import { startHangReport, WindowHangToastId, WindowReloadedToastId } from "./hang-report";
import { Toasts } from "./toast-store";

describe("the window did not respond (#849)", () => {
    beforeEach(() => {
        Toasts.resetInstance();
        env.copied = [];
        Object.defineProperty(globalThis.navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (text: string) => void env.copied.push(text) },
        });
    });

    it("shows a notification with Copy diagnostics once the window answers again, and opens nothing", async () => {
        startHangReport();
        env.hangListener({ ms: 5300, at: Date.now() - 5300 });
        const stack = Toasts.getInstance().stack();
        expect(stack).toHaveLength(1);
        const toast = stack[0];
        expect(toast.id).toBe(WindowHangToastId);
        expect(toast.kind).toBe("warning");
        expect(toast.title).toBe("The window did not respond for 5 s");
        expect(toast.onOpen).toBeUndefined();
        expect(toast.actions.map((a) => a.label)).toEqual(["Copy diagnostics"]);

        await toast.actions[0].run();
        expect(env.copied).toHaveLength(1);
        expect(env.copied[0]).toContain("window unresponsive: 5300 ms");
        expect(env.copied[0]).toContain("tab contents 3 unresponsive");
        expect(Toasts.getInstance().stack()[0].title).toBe("Diagnostics copied");
    });
});

describe("the window was reloaded after its renderer was lost (#973, TC-PERF-020)", () => {
    beforeEach(() => {
        Toasts.resetInstance();
        env.logShown = 0;
    });

    it("says the window stopped and was reloaded, with Show log", async () => {
        startHangReport();
        env.reloadedListener({ reason: "killed", signal: "SIGTERM", at: Date.now() });
        const toast = Toasts.getInstance().stack()[0];
        expect(toast.id).toBe(WindowReloadedToastId);
        expect(toast.kind).toBe("warning");
        expect(toast.title).toBe("The window stopped and was reloaded");
        expect(toast.message).toBe("Its display process was ended (SIGTERM). Your sessions kept running.");
        expect(toast.onOpen).toBeUndefined();
        expect(toast.actions.map((a) => a.label)).toEqual(["Show log"]);
        await toast.actions[0].run();
        expect(env.logShown).toBe(1);
    });
});
