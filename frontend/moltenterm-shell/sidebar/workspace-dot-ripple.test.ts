// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace dots' ripple (FR-SHELL-082, #1943): a dot ripples while an agent of its workspace works, the ring wins
// over it, the current square ripples too, reduced motion stills it, and it costs a stylesheet and nothing more. The
// motion itself is CSS (sidebar.css); these tests read what decides it and what the stylesheet says.

import { globalStore } from "@/app/store/jotaiStore";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { workingAgentCount } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { translateCount } from "../i18n/i18n-core";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { SidebarHeatStepsPerSecond } from "./sidebar-heat";
import { RippleAnimationName, snapRipple, snapRipplesOf, workspaceDotLook } from "./workspace-dot-ripple";

vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: () => {
        throw new Error("no event bus in the test");
    },
}));

const dir = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(`${dir}sidebar.css`, "utf8");
const sidebarSrc = readFileSync(`${dir}workspace-sidebar.tsx`, "utf8");
const rippleSrc = readFileSync(`${dir}workspace-dot-ripple.ts`, "utf8");

let nextVersion = 1;

function info(workspaceid: string, state: string, extra: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return {
        blockid: `${workspaceid}-${state}-${nextVersion}`,
        workspaceid,
        agent: "claude",
        state,
        version: nextVersion++,
        ...extra,
    } as AgentStateInfo;
}

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

describe("which agents make a workspace work", () => {
    it("counts the working ones: the main session and the sub-agents running in the background", () => {
        const agents = [
            info("w", "working"),
            info("w", "working", { background: true, subagents: 2 }),
            info("w", "waiting"),
            info("w", "error"),
            info("w", "done"),
            info("w", "idle"),
        ];
        expect(workingAgentCount(agents)).toBe(2);
    });

    it("counts none for no agent", () => {
        expect(workingAgentCount([])).toBe(0);
        expect(workingAgentCount(null)).toBe(0);
        expect(workingAgentCount([info("w", "waiting"), info("w", "idle")])).toBe(0);
    });
});

describe("the working count of a workspace (AgentStates)", () => {
    const states = () => AgentStates.getInstance();
    const count = (workspace: string) => globalStore.get(states().workspaceWorkingAtom(workspace));

    beforeAll(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        states();
    });

    it("follows the workspace's agents, and stops with the last one", () => {
        const first = info("ws-follow", "working");
        states().apply([first]);
        expect(count("ws-follow")).toBe(1);
        const second = info("ws-follow", "working");
        states().apply([second]);
        expect(count("ws-follow")).toBe(2);
        states().apply([{ ...first, state: "idle", version: nextVersion++ }]);
        expect(count("ws-follow")).toBe(1);
        states().apply([{ ...second, state: "done", version: nextVersion++ }]);
        expect(count("ws-follow")).toBe(0);
    });

    it("still counts an agent at work when another one of the workspace is waiting or in error", () => {
        states().apply([info("ws-urgent", "working"), info("ws-urgent", "waiting"), info("ws-urgent", "error")]);
        expect(count("ws-urgent")).toBe(1);
    });

    it("counts a waiting or idle workspace as none, and keeps the workspaces apart", () => {
        states().apply([info("ws-quiet", "waiting"), info("ws-quiet", "idle"), info("ws-busy", "working")]);
        expect(count("ws-quiet")).toBe(0);
        expect(count("ws-busy")).toBe(1);
    });

    it("hands the dot the same atom for a workspace, so a render never builds a new one", () => {
        expect(states().workspaceWorkingAtom("ws-same")).toBe(states().workspaceWorkingAtom("ws-same"));
    });
});

describe("the look of a dot", () => {
    it("ripples while an agent of its workspace works", () => {
        expect(workspaceDotLook({ active: false, unread: 0, waiting: false, working: 1 })).toEqual({
            ring: false,
            ripple: true,
        });
        expect(workspaceDotLook({ active: false, unread: 0, waiting: false, working: 3 }).ripple).toBe(true);
    });

    it("shows the ring and no ripple while an agent waits, whatever else works", () => {
        expect(workspaceDotLook({ active: false, unread: 0, waiting: true, working: 0 })).toEqual({
            ring: true,
            ripple: false,
        });
        expect(workspaceDotLook({ active: false, unread: 0, waiting: true, working: 2 })).toEqual({
            ring: true,
            ripple: false,
        });
    });

    it("shows the ring and no ripple for unread items too", () => {
        expect(workspaceDotLook({ active: false, unread: 4, waiting: false, working: 0 })).toEqual({
            ring: true,
            ripple: false,
        });
        expect(workspaceDotLook({ active: false, unread: 4, waiting: false, working: 1 }).ripple).toBe(false);
    });

    it("shows nothing for a workspace at rest", () => {
        expect(workspaceDotLook({ active: false, unread: 0, waiting: false, working: 0 })).toEqual({
            ring: false,
            ripple: false,
        });
    });

    it("ripples the current workspace's square too, which never takes the ring", () => {
        expect(workspaceDotLook({ active: true, unread: 0, waiting: false, working: 1 })).toEqual({
            ring: false,
            ripple: true,
        });
        expect(workspaceDotLook({ active: true, unread: 0, waiting: false, working: 0 })).toEqual({
            ring: false,
            ripple: false,
        });
        expect(workspaceDotLook({ active: true, unread: 2, waiting: true, working: 1 })).toEqual({
            ring: false,
            ripple: true,
        });
    });
});

describe("the stylesheet's ripple", () => {
    const pseudo = (which: string, ring = ":not(.has-ring)") => `.mt-sb-dot.is-working${ring}::${which}`;

    it("draws two circles from the dot's pseudo-elements, in the workspace colour, and moves nothing else", () => {
        const body = ruleBody(`${pseudo("before")},\n${pseudo("after")}`);
        expect(body).toContain("position: absolute");
        expect(body).toContain("border: 2.25px solid var(--mt-sb-dot-colour)");
        expect(body).toContain("pointer-events: none");
        expect(body).not.toMatch(/\b(?:right|bottom|margin[-\w]*|padding[-\w]*|display|flex[-\w]*):/);
    });

    it("centres the circles on the dot by a translate, which holds past the 24 px slot", () => {
        const body = ruleBody(`${pseudo("before")},\n${pseudo("after")}`);
        expect(body).toContain("top: 50%;");
        expect(body).toContain("left: 50%;");
        expect(body).toContain("transform: translate(-50%, -50%) scale(");
        expect(body).not.toContain("inset:");
        expect(body).not.toMatch(/margin[-\w]*:\s*auto/);
    });

    it("lets the ring win: the ripple is never drawn on a dot that has the ring", () => {
        const selectors = [...css.matchAll(/^([^{}@\n][^{}]*)\{/gm)]
            .map((m) => m[1])
            .flatMap((list) => list.split(","))
            .map((s) => s.trim())
            .filter((s) => /\.is-working/.test(s) && /::(?:before|after)/.test(s));
        expect(selectors.length).toBeGreaterThan(0);
        for (const selector of selectors) {
            expect(selector, selector).toContain(":not(.has-ring)");
        }
    });

    it("draws outlines only: a thin line in the workspace colour, no fill, no shadow, no glow", () => {
        const body = ruleBody(`${pseudo("before")},\n${pseudo("after")}`);
        expect(body).toContain("border: 2.25px solid var(--mt-sb-dot-colour)");
        expect(body).not.toMatch(/\b(?:background|box-shadow|filter|backdrop-filter|outline)[-\w]*:/);
    });

    it("draws each circle at its final size and scales it up from the dot's, on the compositor", () => {
        const base = ruleBody(`${pseudo("before")},\n${pseudo("after")}`);
        expect(base).toContain("width: calc(var(--mt-sb-ripple-reach) * 1px);");
        expect(base).toContain("height: calc(var(--mt-sb-ripple-reach) * 1px);");
        const body = keyframes("mt-sb-ripple");
        const properties = [...body.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:/g)].map((m) => m[1]);
        expect(new Set(properties)).toEqual(new Set(["transform", "opacity"]));
        expect(body).toMatch(
            /from \{[^}]*transform: translate\(-50%, -50%\) scale\(calc\(var\(--mt-sb-ripple-size\) \/ var\(--mt-sb-ripple-reach\)\)\);[^}]*opacity: 0\.85;/
        );
        expect(body).toMatch(/to \{[^}]*transform: translate\(-50%, -50%\) scale\(1\);[^}]*opacity: 0;/);
    });

    it("plays 2.4 s in whole steps of the shared 1/15 s grid, the second circle half a cycle behind", () => {
        const body = ruleBody(`${pseudo("before")},\n${pseudo("after")}`);
        const m = /animation: mt-sb-ripple ([\d.]+)s steps\((\d+)\) infinite/.exec(body);
        expect(m, "the ripple's animation").not.toBeNull();
        const cycle = Number(m[1]);
        expect(cycle).toBe(2.4);
        expect(Number(m[2])).toBe(cycle * SidebarHeatStepsPerSecond);
        const delay = Number(/animation-delay: ([\d.]+)s/.exec(ruleBody(pseudo("after")))?.[1]);
        expect(delay).toBe(cycle / 2);
        expect(Number.isInteger(delay * SidebarHeatStepsPerSecond)).toBe(true);
    });

    it("keeps the dot's own size and place, and draws its square's ripple from the square's own outline", () => {
        expect(ruleBody(".mt-sb-dot.is-working")).toContain("--mt-sb-ripple-size: 9;");
        expect(ruleBody(".mt-sb-dot.is-working.is-on")).toContain("--mt-sb-ripple-size: 20;");
        expect(ruleBody(".mt-sb-dots.is-many .mt-sb-dot.is-working")).toContain("--mt-sb-ripple-size: 7;");
        expect(ruleBody(".mt-sb-dots.is-many .mt-sb-dot.is-working.is-on")).toContain("--mt-sb-ripple-size: 18;");
        expect(
            ruleBody(
                `.mt-sb-dot.is-working.is-on${":not(.has-ring)"}::before,\n.mt-sb-dot.is-working.is-on${":not(.has-ring)"}::after`
            )
        ).toContain("border-radius: var(--mt-radius-panel)");
    });

    it("reaches 26 px from a dot and 32 px from the current square, beyond the 24 px slot", () => {
        expect(ruleBody(".mt-sb-dot.is-working")).toContain("--mt-sb-ripple-reach: 26;");
        expect(ruleBody(".mt-sb-dot.is-working.is-on")).toContain("--mt-sb-ripple-reach: 32;");
    });

    it("gives the circles the room to be seen and moves nothing: the row's padding is taken back by its margin", () => {
        const room = /\n\.mt-sb-dots \{\s*padding-block: (\d+)px;\s*margin-block: -(\d+)px;\s*\}/.exec(css);
        expect(room, "the row's room").not.toBeNull();
        const padding = Number(room[1]);
        expect(Number(room[2])).toBe(padding);
        const reaches = [...css.matchAll(/--mt-sb-ripple-reach:\s*(\d+);/g)].map((m) => Number(m[1]));
        expect(reaches.length).toBeGreaterThan(0);
        for (const reach of reaches) {
            expect(reach, "a circle's reach").toBeLessThanOrEqual(24 + 2 * padding);
        }
        expect(ruleBody(".mt-sb-dots.is-many")).toContain(`padding: ${padding}px 12px;`);
    });

    it.each([
        [
            "the system preference",
            () => css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n    .mt-sb-dot.is-working")),
        ],
        ["MoltenTerm's own setting", () => css.slice(css.indexOf(".prefers-reduced-motion .mt-sb-dot.is-working"))],
    ])("stands still under %s: no ripple, a faint fixed halo", (_name, area) => {
        const text = area();
        expect(text).toMatch(
            /is-working:not\(\.has-ring\)::before \{[^}]*animation: none;[^}]*transform: translate\(-50%, -50%\);[^}]*width: calc\(var\(--mt-sb-ripple-size\) \* 1px\);[^}]*opacity: 1;[^}]*box-shadow: 0 0 0 3px color-mix/
        );
        expect(text).toMatch(/is-working:not\(\.has-ring\)::after \{[^}]*content: none;/);
    });
});

describe("the dot in the sidebar", () => {
    const start = sidebarSrc.indexOf("function WorkspaceDot(");
    const body = sidebarSrc.slice(start, sidebarSrc.indexOf("\nfunction ", start + 1));

    it("takes its ring and its ripple from one decision, and marks the ripple with is-working", () => {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(body).toContain("workspaceDotLook({ active: entry.active, unread, waiting, working })");
        expect(body).toContain('ripple && "is-working"');
        expect(body).toContain('ring && "has-ring"');
    });

    it("says in its label, and in its popover, that agents are at work", () => {
        expect(body).toContain('attention.push(tc("rail.working", working))');
        expect(body).toContain("const label = [entry.name, ...attention].join");
    });

    it("keeps one listener on the row for every dot, and no timer per dot", () => {
        expect(sidebarSrc.match(/onAnimationStart=\{snapRipplesOf\}/g)).toHaveLength(1);
        expect(body).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
        expect(rippleSrc).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    });
});

describe("the words", () => {
    it("has the label in both languages, counted", () => {
        expect(translateCount("en", "rail.working", 1)).toBe("1 agent at work");
        expect(translateCount("en", "rail.working", 3)).toBe("3 agents at work");
        expect(translateCount("fr", "rail.working", 1)).toBe("1 agent au travail");
        expect(translateCount("fr", "rail.working", 3)).toBe("3 agents au travail");
        for (const dictionary of [en, fr]) {
            expect(Object.keys(dictionary.rail.working).sort()).toEqual(["one", "other"]);
            expect(dictionary.rail.working.other).toContain("{count}");
        }
    });
});

describe("the ripple's start on the shared grid", () => {
    const step = 1000 / SidebarHeatStepsPerSecond;
    const ripple = (startTime: number, animationName = RippleAnimationName) => ({ animationName, startTime });

    it("puts a start back onto the nearest earlier 1/15 s line, never later", () => {
        const anim = ripple(step * 7 + 40);
        snapRipple(anim);
        expect(anim.startTime).toBeCloseTo(step * 7, 6);
        const early = ripple(step * 9 + 0.5);
        snapRipple(early);
        expect(early.startTime).toBeCloseTo(step * 9, 6);
    });

    it("leaves a start already on a line where it is", () => {
        for (const line of [0, 1, 7, 15, 150, 2399]) {
            const anim = ripple(line * step);
            snapRipple(anim);
            expect(anim.startTime).toBeCloseTo(line * step, 6);
        }
    });

    it("leaves another animation, and one that has not started, alone", () => {
        const other = ripple(step * 3 + 20, "mt-sb-dot-pop-rise");
        snapRipple(other);
        expect(other.startTime).toBe(step * 3 + 20);
        const pending = { animationName: RippleAnimationName, startTime: null as number };
        snapRipple(pending);
        expect(pending.startTime).toBeNull();
    });

    it("snaps every ripple under the dot that began one, and ignores the popover's own animation", () => {
        const first = ripple(step * 4 + 30);
        const second = ripple(step * 4 + 30);
        const target = { getAnimations: () => [first, second] } as unknown as EventTarget;
        snapRipplesOf({ animationName: "mt-sb-dot-pop-rise", target });
        expect(first.startTime).toBe(step * 4 + 30);
        snapRipplesOf({ animationName: RippleAnimationName, target });
        expect(first.startTime).toBeCloseTo(step * 4, 6);
        expect(second.startTime).toBeCloseTo(step * 4, 6);
    });
});
