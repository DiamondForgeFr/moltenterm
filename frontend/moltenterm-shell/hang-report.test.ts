// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
    const state = {
        hangListener: null as (hang: { ms: number; at: number }) => void,
        reloadedListener: null as (notice: { reason: string; signal: string; at: number }) => void,
        logShown: 0,
        copied: [] as string[],
        logged: [] as string[],
        observer: null as (list: { getEntries: () => any[] }) => void,
        visibility: "visible",
        listeners: {} as Record<string, (() => void)[]>,
        clock: 0,
    };
    const listen = (name: string, cb: () => void) => {
        (state.listeners[name] ??= []).push(cb);
    };
    class FakeObserver {
        static supportedEntryTypes = ["long-animation-frame", "longtask"];
        constructor(cb: (list: { getEntries: () => any[] }) => void) {
            state.observer = cb;
        }
        observe() {}
    }
    (globalThis as any).PerformanceObserver = FakeObserver;
    (globalThis as any).document = {
        get visibilityState() {
            return state.visibility;
        },
        addEventListener: listen,
    };
    (globalThis as any).window = { addEventListener: listen };
    return state;
});

vi.mock("@/app/store/global", () => ({
    getFocusedBlockId: () => null as string,
    getApi: () => ({
        sendLog: (line: string) => void env.logged.push(line),
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
import { LongTaskLogEveryMs } from "./hang-report-model";
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

describe("a tab view coming back from hidden is not a hang (#1929)", () => {
    const fire = (name: string) => (env.listeners[name] ?? []).forEach((cb) => cb());
    const frame = (entry: { startTime: number; duration: number; blockingDuration?: number; scripts?: any[] }) =>
        env.observer({ getEntries: () => [entry] });

    let wall = Date.now();

    beforeEach(() => {
        startHangReport();
        env.logged = [];
        vi.spyOn(performance, "now").mockImplementation(() => env.clock);
        // each test in its own log period, so the limiter never hides a line one of them expects or forbids
        wall += 10 * LongTaskLogEveryMs;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("logs no hang for a view hidden longer than the threshold, then shown", () => {
        env.clock = 1_000_000;
        env.visibility = "hidden";
        fire("visibilitychange");
        env.clock = 1_090_000;
        env.visibility = "visible";
        fire("visibilitychange");
        frame({ startTime: 999_900, duration: 90_150, blockingDuration: 0, scripts: [] });
        expect(env.logged).toEqual([]);
    });

    it("logs no hang for a frame stretched with nothing running, when the view got no visibility event", () => {
        frame({ startTime: 2_000_000, duration: 81_744, blockingDuration: 0, scripts: [] });
        expect(env.logged).toEqual([]);
    });

    it("still logs a busy frame while the view is visible, with its script", () => {
        env.clock = 3_000_000;
        frame({
            startTime: 3_000_000,
            duration: 5012,
            blockingDuration: 4962,
            scripts: [{ duration: 5000, invoker: "Window.requestIdleCallback", sourceFunctionName: "work" }],
        });
        expect(env.logged).toHaveLength(1);
        expect(env.logged[0]).toMatch(
            /^hang: long frame 5012 ms; script: Window\.requestIdleCallback \(work\) 5000 ms; /
        );
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
