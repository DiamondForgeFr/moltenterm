// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Molten motion (#1163): the shared vocabulary of how an interface changes before the developer's eyes.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { flowClass, flowEntries, MotionClass, MotionMs, settledEntries } from "./molten-motion";

const dir = fileURLToPath(new URL(".", import.meta.url));
const motionCss = readFileSync(`${dir}molten-motion.css`, "utf8");
const tokensCss = readFileSync(`${dir}tokens.css`, "utf8");

const key = (s: string) => s;

describe("molten motion (#1163)", () => {
    it("shows the first list as it is", () => {
        expect(flowEntries([], ["a", "b"], key, true).map((e) => e.phase)).toEqual(["stay", "stay"]);
    });

    it("lets a new item enter, keeps the others, and melts a leaving one out at its former place", () => {
        const first = flowEntries([], ["a", "b", "c"], key, true);
        const next = flowEntries(first, ["a", "x", "c"], key);
        expect(next.map((e) => `${e.key}:${e.phase}`)).toEqual(["a:stay", "b:exit", "x:enter", "c:stay"]);
        expect(settledEntries(next).map((e) => `${e.key}:${e.phase}`)).toEqual(["a:stay", "x:stay", "c:stay"]);
        const head = flowEntries(first, ["b", "c"], key);
        expect(head.map((e) => `${e.key}:${e.phase}`)).toEqual(["a:exit", "b:stay", "c:stay"]);
    });

    it("keeps an entering item entering until it settles", () => {
        const entering = flowEntries(flowEntries([], ["a"], key, true), ["a", "b"], key);
        expect(flowEntries(entering, ["a", "b"], key).map((e) => e.phase)).toEqual(["stay", "enter"]);
    });

    it("names one class per phase", () => {
        expect(flowClass("enter")).toBe(MotionClass.flowIn);
        expect(flowClass("exit")).toBe(MotionClass.meltOut);
        expect(flowClass("stay")).toBe("");
    });

    it("stays under 400 ms, with the tokens the timers use", () => {
        expect(MotionMs.flow).toBeLessThan(400);
        expect(tokensCss).toContain(`--mt-duration-flow: ${MotionMs.flow}ms;`);
        expect(tokensCss).toContain(`--mt-duration-fade: ${MotionMs.fade}ms;`);
    });

    it("draws every motion from the tokens and falls back to a fade under reduced motion", () => {
        for (const cls of Object.values(MotionClass)) {
            expect(motionCss).toContain(`.${cls}`);
        }
        expect(motionCss).not.toMatch(/\d+m?s\s+var\(--mt-ease\)/);
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(motionCss)?.[1] ?? "";
        expect(media).toContain("mt-fade-in var(--mt-duration-fade)");
        expect(media).toContain("mt-fade-out var(--mt-duration-fade)");
        expect(motionCss).toMatch(
            /\.prefers-reduced-motion \.mt-flow-in,[\s\S]*?animation: mt-fade-in var\(--mt-duration-fade\)/
        );
        expect(motionCss).toMatch(
            /\.prefers-reduced-motion \.mt-move,\s*\.prefers-reduced-motion \.mt-glow \{\s*transition: none;/
        );
        const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
        expect(reduced).toContain("--mt-duration-flow: 0ms;");
    });
});
