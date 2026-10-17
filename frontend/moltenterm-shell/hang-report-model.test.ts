// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { describeLastCall } from "./hang-context";
import {
    diagnosticsText,
    hangSeconds,
    LongTaskLimiter,
    longTaskLine,
    LongTaskLogEveryMs,
    topScript,
} from "./hang-report-model";
import { nextTermCacheDelayMs, TermCacheBaseDelayMs, TermCacheMaxDelayMs } from "./term-cache-pace";

describe("renderer hang report (#849)", () => {
    it("logs one long task per period and counts the ones left out", () => {
        const limiter = new LongTaskLimiter();
        expect(limiter.admit(1000)).toBe(0);
        expect(limiter.admit(2000)).toBeNull();
        expect(limiter.admit(3000)).toBeNull();
        expect(limiter.admit(1000 + LongTaskLogEveryMs)).toBe(2);
    });

    it("names the longest script, the last calls and the panel", () => {
        const line = longTaskLine({
            kind: "frame",
            durationMs: 5012.4,
            scripts: [
                { duration: 12, invoker: "TimerHandler:setTimeout" },
                {
                    duration: 5000,
                    invoker: "Window.requestIdleCallback",
                    sourceURL: "app://dist/frontend/assets/termwrap-abc.js?x=1",
                    sourceFunctionName: "processAndCacheData",
                },
            ],
            lastRpc: describeLastCall({ name: "companionopen", at: 900 }, 1000),
            lastService: describeLastCall(null, 1000),
            panel: "term 1234abcd",
            skipped: 3,
        });
        expect(line).toBe(
            "hang: long frame 5012 ms; script: Window.requestIdleCallback (processAndCacheData in termwrap-abc.js) 5000 ms; " +
                "last rpc: companionopen (100 ms before); last service call: none; panel: term 1234abcd; " +
                "3 more long tasks not logged"
        );
        expect(topScript([])).toBe("");
    });

    it("writes the diagnostics in plain text with both sides' events", () => {
        const text = diagnosticsText({
            hangMs: 5200,
            hangAt: Date.UTC(2026, 9, 16, 22, 57, 11),
            main: { version: "1.0.0-4", buildtime: 202610162020, uptimesec: 3600, events: ["e1"] },
            rendererEvents: [],
            userAgent: "UA",
        });
        expect(text).toContain("window unresponsive: 5200 ms from 2026-10-16T22:57:11.000Z");
        expect(text).toContain("version: 1.0.0-4");
        expect(text).toContain("Electron main events:\ne1");
        expect(text).toContain("Renderer long tasks:\n(none)");
        expect(hangSeconds(5200)).toBe(5);
    });

    it("paces a terminal's cache save by what the last one cost", () => {
        expect(nextTermCacheDelayMs(0)).toBe(TermCacheBaseDelayMs);
        expect(nextTermCacheDelayMs(100)).toBe(TermCacheBaseDelayMs);
        expect(nextTermCacheDelayMs(1000)).toBe(20000);
        expect(nextTermCacheDelayMs(10000)).toBe(TermCacheMaxDelayMs);
    });
});
