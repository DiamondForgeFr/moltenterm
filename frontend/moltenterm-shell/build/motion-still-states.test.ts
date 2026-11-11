// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { stripCssComments } from "./token-lint";

// FR-SHELL-118 AC-3 (NFR-SHELL-027): a motion token is 0 under reduced motion, and a loop, which has no duration to
// zero, has a rule that stills it in the same file.

const ShellDir = resolve(__dirname, "..");

// These keep their value under reduced motion: a loop stops by its rule instead of by a zero duration, and fade is
// the reduced form of a flow.
const LoopTokens = new Set(["loop", "spin", "dominoes", "turn", "fade"]);

// The working beat (working-beat.ts) is the rule for an indicator: it runs no animation of its own, so a view draws a
// frame a second at most (#473). These loops are the narrow exceptions, each decided by the developer: a smooth loop that
// is a transform alone on an HTML box (the compositor runs it without a main-thread frame), paused while the window or
// the view is not active, and stopped under both reduced-motion paths. A loop that is not in this list follows the beat.
const SmoothLoops = [
    {
        file: "activity/activity-icon.css",
        selector: ".mt-act",
        keyframes: ["mt-act-turn", "mt-act-flicker"],
        reason:
            "The activity indicator of the title row (FR-BOSS-009 AC85, #2233, decided 2026-11-11): its ring turns like an " +
            "indeterminate download and its flame flickers; at the beat's one step a second they read as ticks, not as " +
            "something running. The flame shares the frames the ring already draws.",
    },
];

function cssFiles(): string[] {
    const files: string[] = [];
    for (const rel of readdirSync(ShellDir, { recursive: true }) as string[]) {
        if (/\.css$/.test(rel)) {
            files.push(join(ShellDir, rel));
        }
    }
    return files;
}

function braceBody(src: string, open: number): string {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        if (src[i] === "}" && --depth === 0) {
            return src.slice(open + 1, i);
        }
    }
    return src.slice(open + 1);
}

function reducedMotionText(src: string): string {
    const re = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;
    let text = "";
    for (let m = re.exec(src); m != null; m = re.exec(src)) {
        text += braceBody(src, m.index + m[0].length - 1);
    }
    return text;
}

describe("reduced motion (NFR-SHELL-027, FR-SHELL-118)", () => {
    const tokens = stripCssComments(readFileSync(join(ShellDir, "tokens.css"), "utf8"));
    const durations = [...tokens.matchAll(/^\s*--mt-duration-([a-z]+):/gm)].map((m) => m[1]);

    it("defines the motion tokens of the theme", () => {
        for (const name of ["fast", "base", "slow", "spin", "dominoes"]) {
            expect(durations).toContain(name);
        }
        expect(tokens).toMatch(/--mt-ease:/);
    });

    it.each([
        ["the system preference", (s: string) => reducedMotionText(s)],
        ["MoltenTerm's own setting", (s: string) => s.slice(s.indexOf("\n.prefers-reduced-motion {"))],
    ])("zeroes every duration that is not a loop under %s", (_name, area) => {
        const text = area(tokens);
        const missing = durations.filter((d) => !LoopTokens.has(d) && !new RegExp(`--mt-duration-${d}:\\s*0ms`).test(text));
        expect(missing).toEqual([]);
    });

    it("stills every infinite animation of MoltenTerm's CSS under the system preference", () => {
        const missing: string[] = [];
        for (const file of cssFiles()) {
            const src = stripCssComments(readFileSync(file, "utf8"));
            const stilled = reducedMotionText(src);
            const rule = /([^{}]+)\{[^{}]*animation:[^;{}]*\binfinite\b[^;{}]*;/g;
            for (let m = rule.exec(src); m != null; m = rule.exec(src)) {
                const cls = /\.([\w-]+)/.exec(m[1]);
                if (cls == null || !new RegExp(`\\.${cls[1]}(?![\\w-])`).test(stilled)) {
                    missing.push(`${file.slice(ShellDir.length + 1)}: ${m[1].trim().split("\n").pop()}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});

describe("the smooth loops that are an exception to the working beat", () => {
    it.each(SmoothLoops)("$file: transform alone, paused when not active, stilled under reduced motion", (loop) => {
        const src = stripCssComments(readFileSync(join(ShellDir, loop.file), "utf8"));
        expect(loop.reason.length).toBeGreaterThan(40);
        for (const name of loop.keyframes) {
            const start = src.indexOf(`@keyframes ${name} {`);
            expect(start, name).toBeGreaterThanOrEqual(0);
            const frames = braceBody(src, src.indexOf("{", start));
            const props = [...frames.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
            expect(new Set(props), `${name} animates only transform`).toEqual(new Set(["transform"]));
            expect(src, name).toMatch(new RegExp(`animation: ${name} [^;]*\\binfinite\\b`));
        }
        expect(src).toMatch(
            new RegExp(`:root\\[data-mt-motion="still"\\] ${loop.selector.replace(".", "\\.")}[^{]*\\{\\s*animation-play-state: paused;`)
        );
        expect(reducedMotionText(src)).toMatch(new RegExp(`${loop.selector.replace(".", "\\.")}[^{]*\\{\\s*animation: none;`));
        expect(src.slice(src.indexOf("\n.prefers-reduced-motion"))).toMatch(/animation: none;/);
    });

    it("lets no other file's infinite animation off the beat unless it is in the list", () => {
        const listed = new Set(SmoothLoops.map((l) => join(ShellDir, l.file)));
        const titleRow = cssFiles().filter((f) => /[\\/]activity[\\/]/.test(f));
        expect(titleRow.every((f) => listed.has(f) || !/infinite/.test(readFileSync(f, "utf8")))).toBe(true);
    });
});
