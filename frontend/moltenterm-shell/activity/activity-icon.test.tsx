// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity indicator of the title row (FR-BOSS-009, AC85, #2233): the four states of its drawing, the detail by
// group, where a click on a row goes, and the rules of its CSS (the colour, the one smooth loop, reduced motion).

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    went: [] as string[],
    projectShown: true,
}));

vi.mock("./activity-store", () => ({ useActivity: () => null }));
vi.mock("../notifications-model", () => ({ formatAge: () => "" }));
vi.mock("../reviews/reviews-agent-bar", () => ({ useMinuteNow: () => 0 }));
vi.mock("../agent-info/agent-info-hooks", () => ({
    goToAgent: async (info: { blockid: string }) => void m.went.push(`agent:${info.blockid}`),
}));
vi.mock("../mission/cicd-open", () => ({
    openCicdTab: async (tab: string) => void m.went.push(`cicd:${tab}`),
}));
vi.mock("../open-view", () => ({
    openMoltentermView: async (view: string) => void m.went.push(`view:${view}`),
}));
vi.mock("../project/project-tab", () => ({
    showProjectTab: async (workspaceId: string) => {
        m.went.push(`project:${workspaceId}`);
        return m.projectShown;
    },
    openProjectOverview: async () => void m.went.push("overview"),
}));
vi.mock("../reviews/reviews-model", () => ({ MoltentermReviewsView: "molten-reviews" }));

import { ActivityMark, ActivityPopoverBody } from "./activity-icon";
import { activityGroups, ActivityWords, EmptyActivity, summarizeActivity, type ActivityItem } from "./activity-model";
import { openActivity } from "./activity-open";

const dir = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(`${dir}activity-icon.css`, "utf8");
const iconSrc = readFileSync(`${dir}activity-icon.tsx`, "utf8");
const sidebarSrc = readFileSync(`${dir}../sidebar/workspace-sidebar.tsx`, "utf8");
const sidebarCss = readFileSync(`${dir}../sidebar/sidebar.css`, "utf8");

function ruleBody(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
}

function item(id: string, kind: ActivityItem["kind"], more: Partial<ActivityItem> = {}): ActivityItem {
    return {
        id,
        kind,
        startedat: 1000,
        target: { type: "build", dir: "/work/p" },
        about: { title: id, detail: "", progress: -1, done: 0, total: 0, subagents: 0 },
        ...more,
    };
}

const words: ActivityWords = {
    t: (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key),
    tc: (key, count) => `${key}:${count}`,
    now: 4000,
    age: (startedat, now) => `${(now - startedat) / 1000}s`,
    server: (_text, english) => english,
};

beforeEach(() => {
    m.went = [];
    m.projectShown = true;
});

describe("the drawing of the indicator", () => {
    it("is a ring of 24 px in a 28 px box with the glyph centred in it, whatever runs", () => {
        const html = renderToStaticMarkup(<ActivityMark glyph="agent" />);
        expect(html).toContain('viewBox="0 0 28 28"');
        expect(html.match(/<circle/g)).toHaveLength(2);
        expect(html.match(/ r="12"/g)).toHaveLength(2);
        expect(html.match(/cx="14" cy="14"/g)).toHaveLength(2);
        expect(ruleBody(".mt-act")).toMatch(/width: 28px;\s*height: 28px;/);
        // Two classes, so the icon font's `.fa` (display: inline-block) and `.fa-fw` (width: 1.25em) cannot win by load
        // order; width: auto lets the inset stretch the box over the ring instead of a 15 px box on the left (#2255).
        const glyph = ruleBody(".mt-act .mt-act-glyph");
        expect(glyph).toMatch(
            /inset: 0;\s*width: auto;\s*display: flex;\s*align-items: center;\s*justify-content: center;\s*text-align: center;/
        );
        expect(glyph).toContain("font-size: var(--mt-text-12)");
        expect(css).not.toContain("\n.mt-act-glyph {");
    });

    it("draws the icon of the panel for one item: sparkles, the list, the hammer", () => {
        expect(renderToStaticMarkup(<ActivityMark glyph="agent" />)).toContain("fa-sparkles");
        expect(renderToStaticMarkup(<ActivityMark glyph="ci" />)).toContain("fa-list-check");
        expect(renderToStaticMarkup(<ActivityMark glyph="build" />)).toContain("fa-hammer");
    });

    it("draws the flame for several items, with the ring and its arc", () => {
        const html = renderToStaticMarkup(<ActivityMark glyph="fire" />);
        expect(html).toContain("fa-fire");
        expect(html).toContain("mt-act-arc");
    });

    it("draws the same flame put out when nothing runs: the ring without its arc", () => {
        const html = renderToStaticMarkup(<ActivityMark glyph="idle" />);
        expect(html).toContain("fa-fire");
        expect(html).toContain("mt-act-track");
        expect(html).not.toContain("mt-act-arc");
        const idleGlyph = ruleBody('.mt-act[data-state="idle"] .mt-act-glyph');
        expect(idleGlyph).toContain("-webkit-text-stroke: 1px var(--mt-text-3)");
        expect(idleGlyph).toContain("opacity: 0.4");
        expect(idleGlyph).toContain("color: transparent");
        expect(ruleBody('.mt-act[data-state="idle"] .mt-act-track')).toContain("stroke-opacity: 0.18");
    });

    it("takes the running state colour of the floor, the muted text colour for the idle flame, and no action colour", () => {
        expect(ruleBody(".mt-act")).toContain("color: var(--mt-state-running)");
        expect(ruleBody(".mt-act-arc")).toContain("stroke: var(--mt-state-running)");
        expect(css).not.toMatch(/--mt-action/);
        const floor = readFileSync(`${dir}../sidebar/sidebar-heat.css`, "utf8");
        expect(floor).toMatch(/--mt-heat-c: var\(--mt-state-running\)/);
        expect(ruleBody(".mt-act-arc")).toContain("stroke-dasharray: 20 56");
    });
});

describe("the one smooth loop of the title row", () => {
    it("turns the ring and flickers the flame as a transform alone, only while something runs", () => {
        const ring = ruleBody('.mt-act[data-state="running"] .mt-act-ring');
        expect(ring).toContain("animation: mt-act-turn 1.1s linear infinite");
        expect(ring).toContain("will-change: transform");
        const flame = ruleBody('.mt-act[data-glyph="fire"] .mt-act-glyph');
        expect(flame).toContain("animation: mt-act-flicker 0.9s ease-in-out infinite");
        for (const name of ["mt-act-turn", "mt-act-flicker"]) {
            const start = css.indexOf(`@keyframes ${name} {`);
            expect(start, name).toBeGreaterThanOrEqual(0);
            const frames = css.slice(start, css.indexOf("\n}\n", start));
            const props = [...frames.matchAll(/^\s+([a-z-]+):/gm)].map((x) => x[1]);
            expect(new Set(props), name).toEqual(new Set(["transform"]));
        }
        expect(css).not.toMatch(/animation-delay|top:[^;]*;\s*}\s*to|left:[^;]*;\s*}\s*to/);
    });

    it("is paused while the window or the view is not active and stopped under reduced motion", () => {
        expect(css).toMatch(
            /:root\[data-mt-motion="still"\] \.mt-act \.mt-act-ring,\s*:root\[data-mt-motion="still"\] \.mt-act \.mt-act-glyph \{\s*animation-play-state: paused;/
        );
        expect(css).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-act \.mt-act-ring,\s*\.mt-act \.mt-act-glyph \{\s*animation: none;/
        );
        expect(css).toMatch(
            /\.prefers-reduced-motion \.mt-act \.mt-act-ring,\s*\.prefers-reduced-motion \.mt-act \.mt-act-glyph \{\s*animation: none;/
        );
    });

    it("animates nothing when idle: no loop outside the running and lit states", () => {
        expect(css.match(/infinite/g)).toHaveLength(3);
        expect(iconSrc).not.toMatch(/setInterval|requestAnimationFrame|useWorkingBeat/);
    });
});

describe("the detail by group", () => {
    it("says the furnaces are out, and why, with nothing running", () => {
        const html = renderToStaticMarkup(
            <ActivityPopoverBody summary={EmptyActivity} words={words} onGo={() => {}} />
        );
        expect(html).toContain("activity.popover.idle");
        expect(html).toContain("activity.popover.none");
        expect(html).not.toContain("activity-row");
    });

    it("lists a row for each item under AGENTS, CI and BUILD, with what, its detail and since", () => {
        const summary = summarizeActivity([
            item("Flore", "agent", {
                startedat: 1000,
                target: { type: "agent", blockid: "b1" },
                about: { title: "Flore", detail: "fixing #2233", progress: -1, done: 0, total: 0, subagents: 0 },
            }),
            item("local", "ci", { startedat: 2000, target: { type: "local-ci", dir: "/work/p" } }),
            item("Gold", "build", { startedat: 3000 }),
        ]);
        const html = renderToStaticMarkup(<ActivityPopoverBody summary={summary} words={words} onGo={() => {}} />);
        expect(html).toContain("activity.popover.many{&quot;count&quot;:3}");
        expect(html.indexOf("activity-group-agents")).toBeLessThan(html.indexOf("activity-group-ci"));
        expect(html.indexOf("activity-group-ci")).toBeLessThan(html.indexOf("activity-group-builds"));
        expect(html.match(/data-testid="activity-row"/g)).toHaveLength(3);
        expect(html).toContain("Flore");
        expect(html).toContain("fixing #2233");
        expect(html).toContain("3s");
        expect(html).toContain('title="activity.open.agent"');
        expect(html).not.toContain("activity.popover.none");
    });

    it("has the groups' titles in capitals by style, not in the text", () => {
        expect(iconSrc).toMatch(/uppercase/);
        const groups = activityGroups(summarizeActivity([item("Gold", "build")]), words);
        expect(groups[0].title).toBe("activity.group.builds:1");
    });
});

describe("an agent that waits for the developer (#2294)", () => {
    const waiting = {
        id: "waiting:b1",
        name: "Flore",
        place: "Cadrage",
        detail: "",
        since: 1000,
        target: { type: "agent" as const, blockid: "b1", tabid: "t1", workspaceid: "ws-1" },
    };

    it("draws the agent's icon in a complete ring, without the running arc, when nothing runs", () => {
        const html = renderToStaticMarkup(<ActivityMark glyph="wait" waits />);
        expect(html).toContain("fa-sparkles");
        expect(html).toContain("mt-act-track");
        expect(html).not.toContain("mt-act-arc");
        expect(html).not.toContain("mt-act-pip");
    });

    it("keeps the running drawing and puts the waiting state's haloed dot on the corner when something runs too", () => {
        const html = renderToStaticMarkup(<ActivityMark glyph="build" waits />);
        expect(html).toContain("mt-act-arc");
        expect(html).toContain("fa-hammer");
        expect(html).toContain("mt-act-pip");
        expect(renderToStaticMarkup(<ActivityMark glyph="build" />)).not.toContain("mt-act-pip");
        const pip = ruleBody(".mt-act-pip");
        expect(pip).toContain("background: var(--mt-state-waiting)");
        expect(pip).toMatch(/box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--mt-state-waiting\) 30%, transparent\)/);
        expect(pip).toContain("pointer-events: none");
    });

    it("takes the waiting state colour of the heat scale: never the action orange, never the running colour", () => {
        expect(ruleBody('.mt-act[data-state="waiting"]')).toContain("color: var(--mt-state-waiting)");
        const track = ruleBody('.mt-act[data-state="waiting"] .mt-act-track');
        expect(track).toContain("stroke: var(--mt-state-waiting)");
        for (const selector of [
            '.mt-act[data-state="waiting"]',
            '.mt-act[data-state="waiting"] .mt-act-track',
            ".mt-act-pip",
        ]) {
            expect(ruleBody(selector), selector).not.toMatch(/--mt-action|--mt-state-running|--mt-state-blocked/);
        }
        const tokens = readFileSync(`${dir}../tokens.css`, "utf8");
        expect(tokens).toMatch(/--mt-state-waiting: #b59cf5/);
    });

    it("breathes in place, opacity alone, on the shell's calm loop, as the workspace dot's ring does", () => {
        const ring = ruleBody('.mt-act[data-state="waiting"] .mt-act-ring');
        expect(ring).toContain("animation: mt-act-wait var(--mt-duration-loop) ease-in-out infinite");
        expect(ring).toContain("will-change: opacity");
        const start = css.indexOf("@keyframes mt-act-wait {");
        expect(start).toBeGreaterThanOrEqual(0);
        const frames = css.slice(start, css.indexOf("\n}\n", start));
        expect(new Set([...frames.matchAll(/^\s+([a-z-]+):/gm)].map((x) => x[1]))).toEqual(new Set(["opacity"]));
        expect(css).not.toMatch(/mt-act-pip[^}]*animation/);
        const dot = readFileSync(`${dir}../sidebar/sidebar.css`, "utf8");
        expect(dot).toMatch(/animation: mt-sb-ring var\(--mt-duration-loop\) ease-in-out infinite/);
    });

    it("lists the agents that wait first, under their own heading in the waiting colour, and goes to the agent", () => {
        const summary = summarizeActivity([item("Gold", "build", { startedat: 3000 })], [waiting]);
        const html = renderToStaticMarkup(<ActivityPopoverBody summary={summary} words={words} onGo={() => {}} />);
        expect(html.indexOf("activity-group-waiting")).toBeLessThan(html.indexOf("activity-group-builds"));
        expect(html).toContain("activity.group.waiting");
        expect(html).toContain("text-[var(--mt-state-waiting)]");
        expect(html).toContain("activity.row.asks{&quot;name&quot;:&quot;Flore&quot;}");
        expect(html).toContain(" · Cadrage");
        expect(html).toContain('title="activity.open.waiting"');
        expect(html).not.toContain("activity.popover.none");
    });

    it("says it waits for you, and not that the furnaces are out, when only an agent waits", () => {
        const summary = summarizeActivity([], [waiting]);
        const html = renderToStaticMarkup(<ActivityPopoverBody summary={summary} words={words} onGo={() => {}} />);
        expect(html).toContain("activity.popover.waiting");
        expect(html).not.toContain("activity.popover.idle");
        expect(html).not.toContain("activity.popover.none");
        expect(html.match(/data-testid="activity-row"/g)).toHaveLength(1);
    });

    it("sets the state of the slot from the glyph, and flags a waiting agent beside a running item", () => {
        expect(iconSrc).toContain('data-state={glyph === "wait" ? "waiting" : summary.count > 0 ? "running" : "idle"}');
        expect(iconSrc).toContain('data-waiting={summary.waiting.length > 0 ? "true" : undefined}');
        expect(iconSrc).toContain("<ActivityMark glyph={glyph} waits={summary.waiting.length > 0} />");
    });

    it("opens the agent's pane on a click on its row", async () => {
        await openActivity(waiting.target);
        expect(m.went).toEqual(["agent:b1"]);
    });
});

describe("where a click on a row goes", () => {
    it("opens an agent's pane, the Integration panel for a pull request, the CI panel's local tab", async () => {
        await openActivity({ type: "agent", blockid: "b9", tabid: "t", workspaceid: "w" });
        await openActivity({ type: "pr-ci", dir: "/work/p", number: 12 });
        await openActivity({ type: "local-ci", dir: "/work/p" });
        expect(m.went).toEqual(["agent:b9", "view:molten-reviews", "cicd:local"]);
    });

    it("opens the project's tab for a build, the project overview when it has none", async () => {
        await openActivity({ type: "build", dir: "/work/p", workspaceid: "ws-1" });
        expect(m.went).toEqual(["project:ws-1"]);
        m.went = [];
        m.projectShown = false;
        await openActivity({ type: "build", dir: "/work/p" });
        expect(m.went).toEqual(["project:", "overview"]);
    });

    it("opens nothing for a target it does not know", async () => {
        await openActivity(null);
        expect(m.went).toEqual([]);
    });
});

describe("its place in the title row", () => {
    it("stands on the left of Brokk's face, after the spacer, and the row never moves him", () => {
        const row = sidebarSrc.slice(
            sidebarSrc.indexOf("function WindowRow"),
            sidebarSrc.indexOf("function usePanelArrived")
        );
        const spacer = row.indexOf('<div className="h-full flex-1" />');
        const icon = row.indexOf("<ActivityIcon />");
        const face = row.indexOf("<BrokkAvatarSlot />");
        expect(spacer).toBeGreaterThan(0);
        expect(icon).toBeGreaterThan(spacer);
        expect(face).toBeGreaterThan(icon);
    });

    it("is not hidden with the rest of the row on the collapsed sidebar", () => {
        expect(sidebarCss).toContain(".mt-sb[data-edge] .mt-sb-window-row > :not(.mt-brokk-avatar, .mt-act)");
    });

    it("is a button that never takes the focus from the terminal when pressed, with the pointer cursor", () => {
        expect(iconSrc).toContain("onMouseDown={(e) => e.preventDefault()}");
        expect(ruleBody(".mt-act")).toContain("cursor: pointer");
        expect(ruleBody(".mt-act")).toContain("-webkit-app-region: no-drag");
    });
});
