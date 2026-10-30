// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Panel motion (FR-SHELL-112, #1349): the view pour, a panel's arrival and a working agent's turning light, one
// moment at a time, transform and opacity only, each with its still state under reduced motion (NFR-SHELL-027).

import { globalStore } from "@/app/store/jotaiStore";
import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStateInfo } from "../agent-state-model";
import { ArrivalDeps, ArrivalShownGraceMs, PanelArrival } from "./panel-arrival-model";
import { markPour, notifyViewPour, onViewPour, pourWaitMs, resetPourMomentForTest } from "./pour-moment";
import { parseCssTime, playPour, PourAnimationId, pourKeyframes, PourShiftPx } from "./view-pour";
import { isAgentWorking, TileAgentMark, withWorkingTitle, WorkingLight } from "./working-light";

const dir = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(`${dir}panel-motion.css`, "utf8");
const tokensCss = readFileSync(`${dir}../tokens.css`, "utf8");
const sidebarSrc = readFileSync(`${dir}../sidebar/workspace-sidebar.tsx`, "utf8");

function keyframeBlocks(src: string): Map<string, string> {
    const blocks = new Map<string, string>();
    const re = /@keyframes\s+([\w-]+)\s*{/g;
    let m: RegExpExecArray;
    while ((m = re.exec(src)) != null) {
        let depth = 1;
        let i = re.lastIndex;
        while (depth > 0 && i < src.length) {
            if (src[i] === "{") depth++;
            if (src[i] === "}") depth--;
            i++;
        }
        blocks.set(m[1], src.slice(re.lastIndex, i - 1));
    }
    return blocks;
}

function functionSource(src: string, name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf("\n}\n", start));
}

type FakeAnimation = { id: string; cancel: () => void };

function fakeEl(opts: { base?: string; reduced?: boolean; running?: FakeAnimation[] } = {}) {
    const animate = vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => ({ frames, options }) as any);
    const doc = {
        querySelector: (sel: string) => (sel === ".prefers-reduced-motion" && opts.reduced ? {} : null),
        defaultView: {
            matchMedia: () => ({ matches: false }),
            getComputedStyle: () => ({
                getPropertyValue: (name: string) =>
                    name === "--mt-duration-base"
                        ? (opts.base ?? "180ms")
                        : name === "--mt-ease"
                          ? " cubic-bezier(0.2, 0, 0, 1)"
                          : "",
            }),
        },
    };
    const el = { ownerDocument: doc, animate, getAnimations: () => opts.running ?? [] } as unknown as HTMLElement;
    return { el, animate };
}

afterEach(() => {
    resetPourMomentForTest();
});

describe("the view pour (FR-SHELL-112)", () => {
    it("reads the token's time", () => {
        expect(parseCssTime("180ms")).toBe(180);
        expect(parseCssTime(" 0.18s ")).toBe(180);
        expect(parseCssTime("0ms")).toBe(0);
        expect(parseCssTime("")).toBeNaN();
    });

    it("slides 8 px from the tiles' side and fades in, with transform and opacity only", () => {
        expect(PourShiftPx).toBe(8);
        expect(pourKeyframes("x")).toEqual([
            { opacity: 0, transform: "translateX(-8px)" },
            { opacity: 1, transform: "none" },
        ]);
        expect(pourKeyframes("y")[0].transform).toBe("translateY(-8px)");
        for (const frame of [...pourKeyframes("x"), ...pourKeyframes("y")]) {
            expect(Object.keys(frame).sort()).toEqual(["opacity", "transform"]);
        }
    });

    it("plays over --mt-duration-base with --mt-ease, and holds the view's moment meanwhile", () => {
        const { el, animate } = fakeEl();
        const before = globalThis.performance.now();
        expect(playPour(el, "x")).not.toBeNull();
        expect(animate).toHaveBeenCalledTimes(1);
        expect(animate.mock.calls[0][1]).toEqual({
            duration: 180,
            easing: "cubic-bezier(0.2, 0, 0, 1)",
            id: PourAnimationId,
        });
        expect(pourWaitMs(before)).toBeGreaterThanOrEqual(180);
    });

    it("follows the token when it is slowed down", () => {
        const { el, animate } = fakeEl({ base: "2s" });
        playPour(el, "x");
        expect(animate.mock.calls[0][1].duration).toBe(2000);
    });

    it("replaces a pour still running", () => {
        const old = { id: PourAnimationId, cancel: vi.fn() };
        const other = { id: "something-else", cancel: vi.fn() };
        const { el } = fakeEl({ running: [old, other] });
        playPour(el, "x");
        expect(old.cancel).toHaveBeenCalled();
        expect(other.cancel).not.toHaveBeenCalled();
    });

    it("moves nothing under reduced motion, nor with a 0 duration", () => {
        const reduced = fakeEl({ reduced: true });
        expect(playPour(reduced.el, "x")).toBeNull();
        expect(reduced.animate).not.toHaveBeenCalled();
        const instant = fakeEl({ base: "0ms" });
        expect(playPour(instant.el, "x")).toBeNull();
        expect(instant.animate).not.toHaveBeenCalled();
        expect(pourWaitMs()).toBe(0);
    });

    it("tells its listeners once it started", () => {
        const cb = vi.fn();
        const stop = onViewPour(cb);
        notifyViewPour();
        stop();
        notifyViewPour();
        expect(cb).toHaveBeenCalledTimes(1);
    });
});

function arrivalDeps(showing: boolean) {
    const state = { showing, wait: 0 };
    const activity = new Set<() => void>();
    const pours = new Set<() => void>();
    const timers: { cb: () => void; ms: number; cancelled: boolean }[] = [];
    const deps: ArrivalDeps = {
        showing: () => state.showing,
        onActivity: (cb) => {
            activity.add(cb);
            return () => activity.delete(cb);
        },
        onPour: (cb) => {
            pours.add(cb);
            return () => pours.delete(cb);
        },
        waitMs: () => state.wait,
        later: (cb, ms) => {
            const timer = { cb, ms, cancelled: false };
            timers.push(timer);
            return () => {
                timer.cancelled = true;
            };
        },
    };
    return { state, deps, activity, pours, timers };
}

describe("a panel's arrival (FR-SHELL-112)", () => {
    it("plays for a panel added beside others, not for the first panel of a new view", () => {
        const { deps } = arrivalDeps(true);
        const model = PanelArrival.makeForTest(deps);
        model.note(["only"], 1);
        expect(globalStore.get(model.seqAtom("only"))).toBe(0);
        model.note(["b"], 2);
        expect(globalStore.get(model.seqAtom("b"))).toBeGreaterThan(0);
    });

    it("waits for the view's pour (one moment at a time)", () => {
        const { state, deps } = arrivalDeps(true);
        state.wait = 140;
        const model = PanelArrival.makeForTest(deps);
        model.note(["b"], 2);
        expect(model.delayMs("b")).toBe(140);
    });

    it("ends once its edge has run, and only for its own run", () => {
        const { deps } = arrivalDeps(true);
        const model = PanelArrival.makeForTest(deps);
        model.note(["b"], 2);
        const first = globalStore.get(model.seqAtom("b"));
        model.note(["b"], 3);
        model.done("b", first);
        expect(globalStore.get(model.seqAtom("b"))).toBeGreaterThan(first);
        model.done("b", globalStore.get(model.seqAtom("b")));
        expect(globalStore.get(model.seqAtom("b"))).toBe(0);
    });

    it("keeps a panel added while the view is off screen for the switch back, after its pour", () => {
        const { state, deps, pours } = arrivalDeps(false);
        const model = PanelArrival.makeForTest(deps);
        model.note(["b"], 2);
        expect(globalStore.get(model.seqAtom("b"))).toBe(0);
        state.showing = true;
        state.wait = 180;
        pours.forEach((cb) => cb());
        expect(globalStore.get(model.seqAtom("b"))).toBeGreaterThan(0);
        expect(model.delayMs("b")).toBe(180);
        expect(pours.size).toBe(0);
    });

    it("plays after a grace when the view comes back without a switch (a restored window)", () => {
        const { state, deps, activity, timers } = arrivalDeps(false);
        const model = PanelArrival.makeForTest(deps);
        model.note(["b"], 2);
        state.showing = true;
        activity.forEach((cb) => cb());
        expect(timers).toHaveLength(1);
        expect(timers[0].ms).toBe(ArrivalShownGraceMs);
        expect(globalStore.get(model.seqAtom("b"))).toBe(0);
        timers[0].cb();
        expect(globalStore.get(model.seqAtom("b"))).toBeGreaterThan(0);
        expect(activity.size).toBe(0);
    });
});

const working: AgentStateInfo = { blockid: "b1", agent: "claude", firstname: "Olivia", state: "working", version: 1 };
const waiting: AgentStateInfo = { blockid: "b1", agent: "claude", firstname: "Olivia", state: "waiting", version: 1 };

describe("a working agent's turning light (FR-SHELL-112)", () => {
    it("shows on the tile only while the agent works", () => {
        expect(isAgentWorking(working)).toBe(true);
        expect(isAgentWorking(waiting)).toBe(false);
        expect(isAgentWorking(null)).toBe(false);
        expect(renderToStaticMarkup(<WorkingLight on={true} />)).toMatch(
            /<span class="df-glow mt-working-light" data-on=""[^>]*aria-hidden="true"/
        );
        expect(renderToStaticMarkup(<WorkingLight on={false} />)).toBe("");
    });

    it("replaces the corner dot, keeping the state for assistive technologies and in the tooltip", () => {
        const mark = renderToStaticMarkup(<TileAgentMark info={working} />);
        expect(mark).toContain('class="sr-only"');
        expect(mark).toContain('role="img"');
        expect(mark).not.toContain("molten-tab-dot");
        expect(renderToStaticMarkup(<TileAgentMark info={waiting} />)).toContain("molten-tab-dot");
        expect(withWorkingTitle("Build", working)).toMatch(/^Build\n.+/);
        expect(withWorkingTitle("Build", waiting)).toBe("Build");
    });

    it("lights the view tiles and the top row's blocks, and lights the clicked one at a switch", () => {
        for (const name of ["Tile", "TopRowBlock"]) {
            const src = functionSource(sidebarSrc, name);
            expect(src, name).toContain("<WorkingLight on=");
            expect(src, name).toContain("<PourLight active={active} />");
        }
        expect(functionSource(sidebarSrc, "Tile")).toContain("<TileAgentMark info={identity.agent} />");
        expect(functionSource(sidebarSrc, "TopRowAgentMark")).toContain("<TileAgentMark info={identity.agent} />");
    });
});

describe("panel motion's stylesheet (FR-SHELL-112, NFR-SHELL-027)", () => {
    it("animates transform and opacity only", () => {
        const blocks = keyframeBlocks(css);
        expect([...blocks.keys()].sort()).toEqual(["mt-arrival-out", "mt-arrival-run", "mt-light-cool", "mt-pour-lit"]);
        for (const [name, body] of blocks) {
            const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
            expect(props.length, name).toBeGreaterThan(0);
            for (const p of props) {
                expect(["opacity", "transform"], `${name}: ${p}`).toContain(p);
            }
        }
    });

    it("lights the tile and pours on the base duration with the molten ease", () => {
        expect(css).toMatch(
            /\.mt-pour-lit \{[^}]*animation: mt-pour-lit var\(--mt-duration-base\) var\(--mt-ease\) both;/
        );
    });

    it("turns the light in incandescent, in steps over --mt-duration-turn, held still off the active view", () => {
        expect(css).toMatch(/\.mt-working-light \{[^}]*--df-accent: var\(--mt-state-running\);/);
        expect(css).toMatch(
            /\.mt-working-light::before \{\s*animation: df-glow-turn var\(--mt-duration-turn\) steps\(32\) infinite;/
        );
        expect(css).toMatch(
            /:root\[data-mt-motion="still"\] \.mt-working-light::before \{\s*animation-play-state: paused;/
        );
        expect(css).toMatch(
            /\.mt-working-light\[data-cooling\] \{\s*animation: mt-light-cool var\(--mt-duration-cool\) var\(--mt-ease-cool\) both;/
        );
    });

    it("runs no other loop than the working light", () => {
        const loops = [...css.matchAll(/animation:[^;]*infinite/g)].map((m) => m[0]);
        expect(loops).toEqual(["animation: df-glow-turn var(--mt-duration-turn) steps(32) infinite"]);
    });

    it("stills each moment under the system's preference and MoltenTerm's own setting", () => {
        const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
        const own = css.slice(css.indexOf(".prefers-reduced-motion .mt-pour-lit"));
        for (const block of [media, own]) {
            expect(block).toMatch(/\.mt-pour-lit \{\s*display: none;/);
            expect(block).toMatch(/\.mt-panel-arrival > span \{\s*animation: none;\s*background: var\(--mt-action\);/);
            expect(block).toMatch(/\.mt-panel-arrival \{\s*animation: mt-fade-out var\(--mt-duration-fade\) linear/);
            expect(block).toMatch(/\.mt-working-light::before \{\s*animation: none;/);
        }
    });

    it("defines the turn and the cool-down tokens, the cool-down instant under reduced motion", () => {
        expect(tokensCss).toMatch(/--mt-duration-turn: 8s;/);
        expect(tokensCss).toMatch(/--mt-duration-cool: 1600ms;/);
        expect(tokensCss).toMatch(/--mt-ease-cool: cubic-bezier\(0\.3, 0, 0\.1, 1\);/);
        const media = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-motion: reduce)"));
        expect(media.slice(0, media.indexOf("}\n}"))).toContain("--mt-duration-cool: 0ms;");
        const own = tokensCss.slice(tokensCss.indexOf("\n.prefers-reduced-motion {"));
        expect(own.slice(0, own.indexOf("}"))).toContain("--mt-duration-cool: 0ms;");
    });
});

describe("the pour's moment", () => {
    it("is over once its time has passed", () => {
        const before = globalThis.performance.now();
        markPour(100);
        expect(pourWaitMs(before)).toBeGreaterThanOrEqual(100);
        expect(pourWaitMs(before + 1e9)).toBe(0);
    });
});
