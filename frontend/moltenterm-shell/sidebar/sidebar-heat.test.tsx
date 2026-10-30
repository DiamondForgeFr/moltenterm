// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's heat (FR-SHELL-122, DS-SHELL-133, #1409): shown only while agents of the workspace work, stronger with
// more of them, off with the setting, reduced motion or the sidebar away, and changing only on the shared frames.

import { readFileSync } from "fs";
import { getDefaultStore, type PrimitiveAtom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "url";
import { describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";

const mocks = vi.hoisted(() => ({ setting: null as PrimitiveAtom<boolean>, reduced: null as PrimitiveAtom<boolean> }));

vi.mock("@/app/store/global", async () => {
    const jotai = await import("jotai");
    mocks.setting = jotai.atom(undefined as boolean) as PrimitiveAtom<boolean>;
    mocks.reduced = jotai.atom(false) as PrimitiveAtom<boolean>;
    return {
        atoms: { prefersReducedMotionAtom: mocks.reduced },
        getSettingsKeyAtom: () => mocks.setting,
    };
});

import {
    isHeatTooSmall,
    SidebarHeat,
    sidebarHeatLevel,
    SidebarHeatMinHeightPx,
    SidebarHeatSettingKey,
    SidebarHeatStepsPerSecond,
    snapRise,
} from "./sidebar-heat";

const dir = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(`${dir}sidebar-heat.css`, "utf8");
const sidebarSrc = readFileSync(`${dir}workspace-sidebar.tsx`, "utf8");
const metaSrc = readFileSync(`${dir}../../../pkg/molten/settingsmeta/settingsmeta.go`, "utf8");

const agent = (state: string): AgentStateInfo => ({ state, blockid: state + Math.random() }) as AgentStateInfo;

function ruleBody(selector: string): string {
    const start = css.lastIndexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
}

function keyframes(name: string): string {
    const start = css.indexOf(`\n@keyframes ${name} {`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("\n}\n", start));
}

function render(agents: AgentStateInfo[], shown = true, setting: boolean = undefined, reduced = false): string {
    const store = getDefaultStore();
    store.set(mocks.setting, setting);
    store.set(mocks.reduced, reduced);
    return renderToStaticMarkup(<SidebarHeat agents={agents} shown={shown} />);
}

describe("the sidebar's heat (#1409)", () => {
    it("follows the working agents of the workspace, 1 to 3", () => {
        expect(sidebarHeatLevel([])).toBe(0);
        expect(sidebarHeatLevel(null)).toBe(0);
        expect(sidebarHeatLevel([agent("idle"), agent("waiting"), agent("done"), agent("error")])).toBe(0);
        expect(sidebarHeatLevel([agent("working"), agent("waiting")])).toBe(1);
        expect(sidebarHeatLevel([agent("working"), agent("working")])).toBe(2);
        expect(sidebarHeatLevel([1, 2, 3, 4, 5].map(() => agent("working")))).toBe(3);
    });

    it("shows only while an agent works, the sidebar shows, the setting allows it and motion is not reduced", () => {
        expect(render([agent("idle")])).toBe("");
        const on = render([agent("working"), agent("working")]);
        expect(on).toContain('data-testid="sidebar-heat"');
        expect(on).toContain('data-level="2"');
        expect(on).toContain('aria-hidden="true"');
        expect(render([agent("working")], true, true)).toContain('data-level="1"');
        expect(render([agent("working")], true, false)).toBe("");
        expect(render([agent("working")], false)).toBe("");
        expect(render([agent("working")], true, undefined, true)).toBe("");
    });

    it("puts a rise back onto a whole cycle when it starts, and onto the nearest step at a lap", () => {
        const anim = (startTime: number, duration = 7000, animationName = "mt-sb-heat-rise-a") => ({
            animationName,
            startTime: startTime as CSSNumberish,
            effect: { getComputedTiming: () => ({ duration }) } as AnimationEffect,
        });
        const started = anim(15_432.1);
        snapRise(started, false);
        expect(started.startTime).toBe(14_000);
        const step = 1000 / SidebarHeatStepsPerSecond;
        const lap = anim(15_432.1);
        snapRise(lap, true);
        expect(lap.startTime).toBeCloseTo(Math.round(15_432.1 / step) * step, 6);
        expect(Math.abs(Number(lap.startTime) - 15_432.1)).toBeLessThanOrEqual(step / 2);
        for (const other of [anim(1234.5, 7000, "mt-sb-heat-in"), anim(1234.5, Infinity), anim(1234.5, 0)]) {
            snapRise(other, false);
            expect(other.startTime).toBe(1234.5);
        }
        const pending = { ...anim(0), startTime: null as CSSNumberish };
        snapRise(pending, false);
        expect(pending.startTime).toBeNull();
    });

    it("moves each layer one tile per whole-second cycle, 15 steps a second, transform only and with no delay", () => {
        expect(css).not.toMatch(/animation-delay/);
        expect(css).not.toMatch(/--mt-action/);
        expect(css).toMatch(/--mt-heat-c: var\(--mt-state-running\)/);
        for (const layer of ["a", "b", "c"]) {
            const body = ruleBody(`.mt-sb-heat-layer.is-${layer}`);
            const tile = Number(/background-size: 100% (\d+)px/.exec(body)?.[1]);
            expect(body).toContain(`bottom: -${tile}px`);
            const seconds = Number(/animation-duration: (\d+)s/.exec(body)?.[1]);
            expect(Number.isInteger(seconds) && seconds > 0, layer).toBe(true);
            expect(body).toContain(`animation-timing-function: steps(${seconds * SidebarHeatStepsPerSecond})`);
            const name = /animation-name: ([\w-]+)/.exec(body)?.[1];
            expect(name).toBe(`mt-sb-heat-rise-${layer}`);
            const frames = ruleBody(`@keyframes ${name}`);
            expect(frames).toContain(`transform: translateY(-${tile}px)`);
            expect(frames).not.toMatch(/opacity|top:|height:/);
        }
        expect(css).toMatch(/:root\[data-mt-motion="still"\] \.mt-sb-heat-layer,/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-sb-heat \{\s*display: none;/);
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-sb-heat \{\s*display: none;/);
        expect(ruleBody(".mt-sb-heat")).toContain("pointer-events: none");
    });

    it("rises from a molten bath whose waves and highlights flow one tile per cycle on the same frames (#1457)", () => {
        const on = render([agent("working")]);
        const bath = on.indexOf('data-testid="sidebar-heat-bath"');
        expect(bath).toBeGreaterThan(on.indexOf("mt-sb-heat-embers"));
        expect(on.slice(bath)).toMatch(
            /mt-sb-heat-iron[\s\S]*mt-sb-heat-molten[\s\S]*is-back[\s\S]*is-front[\s\S]*glint/
        );
        expect(ruleBody(".mt-sb-heat-embers")).toContain("bottom: calc(var(--mt-heat-bath) - 5px)");
        expect(ruleBody(".mt-sb-heat-bath")).toContain("height: var(--mt-heat-bath)");
        const flows: [string, string, string][] = [
            [".mt-sb-heat-wave.is-back", "mask-size", "translateX(140px)"],
            [".mt-sb-heat-wave.is-front", "mask-size", "translateX(-90px)"],
            [".mt-sb-heat-glint", "background-size", "translateX(560px)"],
        ];
        for (const [selector, sizeProp, move] of flows) {
            const body = ruleBody(selector);
            const tile = Number(new RegExp(`${sizeProp}: (\\d+)px 100%`).exec(body)?.[1]);
            expect(move, selector).toContain(`(${body.includes(`left: -${tile}px`) ? "" : "-"}${tile}px)`);
            const seconds = Number(/animation-duration: (\d+)s/.exec(body)?.[1]);
            expect(Number.isInteger(seconds) && seconds > 0, selector).toBe(true);
            expect(body).toContain(`animation-timing-function: steps(${seconds * SidebarHeatStepsPerSecond})`);
            const name = /animation-name: ([\w-]+)/.exec(body)?.[1];
            expect(name).toMatch(/^mt-sb-heat-flow-/);
            const frames = ruleBody(`@keyframes ${name}`);
            expect(frames).toContain(`transform: ${move}`);
            expect(frames).not.toMatch(/opacity|top:|left:|width:|d:/);
        }
        expect(css).not.toMatch(/@keyframes [\w-]+ \{[^@]*\bd: path/);
        const flow = {
            animationName: "mt-sb-heat-flow-front",
            startTime: 15_432.1 as CSSNumberish,
            effect: { getComputedTiming: () => ({ duration: 6000 }) } as AnimationEffect,
        };
        snapRise(flow, false);
        expect(flow.startTime).toBe(12_000);
    });

    it("enters bath first then embers, and leaves embers first then the bath cooling and sinking, with no delay", () => {
        const enterBath = keyframes("mt-sb-heat-bath-in");
        expect(enterBath).toMatch(/0% \{\s*transform: translateY\(100%\);\s*opacity: 0;/);
        expect(enterBath).toMatch(/45%,\s*100% \{\s*transform: none;/);
        expect(keyframes("mt-sb-heat-embers-in")).toMatch(/0%,\s*45% \{\s*opacity: 0;/);
        expect(keyframes("mt-sb-heat-embers-out")).toMatch(/22%,\s*100% \{\s*opacity: 0;/);
        expect(keyframes("mt-sb-heat-molten-out")).toMatch(/0%,\s*15% \{\s*opacity: 1;/);
        expect(keyframes("mt-sb-heat-bath-out")).toMatch(/0%,\s*62% \{\s*transform: none;/);
        expect(keyframes("mt-sb-heat-bath-out")).toContain("translateY(100%)");
        for (const part of ["glow", "embers", "bath", "molten"]) {
            expect(ruleBody(`.mt-sb-heat-${part}`)).toContain(`mt-sb-heat-${part}-in var(--mt-heat-enter)`);
            expect(ruleBody(`.mt-sb-heat[data-cooling] .mt-sb-heat-${part}`)).toContain(
                `mt-sb-heat-${part}-out var(--mt-heat-leave)`
            );
        }
        expect(ruleBody(".mt-sb-heat[data-cooling]")).toContain("mt-sb-heat-out var(--mt-heat-leave)");
        expect(css).not.toMatch(/animation-delay|animation:[^;]*\d+m?s[^;]*\d+m?s/);
        expect(css).toMatch(/:root\[data-mt-motion="still"\] \.mt-sb-heat-wave,/);
        expect(css).toMatch(/:root\[data-mt-motion="still"\] \.mt-sb-heat-glint \{\s*animation-play-state: paused;/);
    });

    it("draws nothing in too little free space, measured without a size container that would restart the rises", () => {
        expect(isHeatTooSmall(0)).toBe(true);
        expect(isHeatTooSmall(SidebarHeatMinHeightPx - 1)).toBe(true);
        expect(isHeatTooSmall(SidebarHeatMinHeightPx)).toBe(false);
        expect(css).not.toMatch(/container-type|@container/);
        expect(css).toMatch(/\.mt-sb-heat\[data-small\] > \* \{\s*display: none;/);
    });

    it("sits in the sidebar page's free space, after its last section, and is a setting on by default", () => {
        const page = sidebarSrc.slice(
            sidebarSrc.indexOf("<TemporaryViews"),
            sidebarSrc.indexOf("</>", sidebarSrc.indexOf("<TemporaryViews"))
        );
        expect(page).toContain("<SidebarHeat agents={sections.agents} shown={!hidden || peek} />");
        expect(metaSrc).toContain(`{Key: "${SidebarHeatSettingKey}", Section: SectionAppearance, Group: "Window"`);
        expect(metaSrc).toMatch(/moltenterm:sidebarheat".*Default: true/);
    });
});
