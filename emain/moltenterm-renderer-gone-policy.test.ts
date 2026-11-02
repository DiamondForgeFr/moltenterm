// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    isRecoverableLoss,
    KillBurstDetector,
    killBurstLine,
    RendererReloadLimit,
    RendererReloadPolicy,
    RendererReloadWindowMs,
    signalName,
} from "./moltenterm-renderer-gone-policy";

describe("renderer reload policy (#973, TC-PERF-021)", () => {
    it("reloads a window up to the limit within a minute, then stops", () => {
        const policy = new RendererReloadPolicy();
        const decisions = [0, 1000, 2000, 3000].map((t) => policy.admit("win", 10000 + t).reload);
        expect(RendererReloadLimit).toBe(3);
        expect(decisions).toEqual([true, true, true, false]);
    });

    it("counts each window apart", () => {
        const policy = new RendererReloadPolicy();
        for (let i = 0; i < RendererReloadLimit; i++) policy.admit("a", 1000 + i);
        expect(policy.admit("a", 2000).reload).toBe(false);
        expect(policy.admit("b", 2000).reload).toBe(true);
    });

    it("reloads again once the earlier reloads are older than the window", () => {
        const policy = new RendererReloadPolicy();
        for (let i = 0; i < RendererReloadLimit; i++) policy.admit("win", 1000 + i);
        expect(policy.admit("win", 1000 + RendererReloadWindowMs - 1).reload).toBe(false);
        expect(policy.admit("win", 1002 + RendererReloadWindowMs).reload).toBe(true);
    });

    it("starts the count again after a reset (the developer's Reload)", () => {
        const policy = new RendererReloadPolicy();
        for (let i = 0; i < RendererReloadLimit; i++) policy.admit("win", 1000 + i);
        policy.reset("win");
        expect(policy.admit("win", 2000)).toEqual({ reload: true, count: 1 });
    });
});

describe("renderer loss reasons", () => {
    it("recovers from kills, crashes and memory, not from a clean exit", () => {
        expect(isRecoverableLoss("killed")).toBe(true);
        expect(isRecoverableLoss("crashed")).toBe(true);
        expect(isRecoverableLoss("oom")).toBe(true);
        expect(isRecoverableLoss("clean-exit")).toBe(false);
    });

    it("names the signal of a killed renderer", () => {
        expect(signalName("killed", 15)).toBe("SIGTERM");
        expect(signalName("killed", 9)).toBe("SIGKILL");
        expect(signalName("killed", 31)).toBe("signal 31");
        expect(signalName("crashed", 11)).toBeNull();
    });
});

describe("external kill detection (#973, TC-PERF-022)", () => {
    it("groups renderers killed by the same signal together", () => {
        const d = new KillBurstDetector();
        expect(d.add({ pid: 101, at: 1000, signal: "SIGTERM" })).toBe(true);
        expect(d.add({ pid: 102, at: 1002, signal: "SIGTERM" })).toBe(false);
        expect(d.add({ pid: 103, at: 1005, signal: "SIGTERM" })).toBe(false);
        expect(d.close()).toEqual({ signal: "SIGTERM", count: 3, pids: [101, 102, 103], spanMs: 5 });
    });

    it("does not report a single killed renderer", () => {
        const d = new KillBurstDetector();
        d.add({ pid: 101, at: 1000, signal: "SIGTERM" });
        expect(d.close()).toBeNull();
    });

    it("ignores losses without a signal and starts a new burst after closing", () => {
        const d = new KillBurstDetector();
        expect(d.add({ pid: 101, at: 1000, signal: null })).toBe(false);
        expect(d.close()).toBeNull();
        expect(d.add({ pid: 102, at: 3000, signal: "SIGKILL" })).toBe(true);
    });

    it("writes a line with the pids, main's signal and the memory", () => {
        const line = killBurstLine({ signal: "SIGTERM", count: 2, pids: [101, 102], spanMs: 3 }, null, 2048, 65536);
        expect(line).toContain("external kill: 2 renderers ended by SIGTERM within 3 ms (pids 101, 102)");
        expect(line).toContain("Electron main caught no signal");
        expect(line).toContain("free memory 2048 MB of 65536 MB");
    });
});
