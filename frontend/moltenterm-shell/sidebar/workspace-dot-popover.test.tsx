// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace dots' popover (FR-SHELL-082, #1645): what it says, when it shows, and that the dots lost their native
// title.

import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate, translateCount } from "../i18n/i18n-core";
import { formatKeys } from "../shortcuts/format";
import { workspaceJumpKeys } from "./sidebar-keys";
import { WorkspaceDotCard, WorkspaceDotCardProps } from "./workspace-dot-popover";
import { DotPopoverHover, dotAttention, dotPopoverProject, dotShowsPopover } from "./workspace-dot-popover-model";

function card(props: Partial<WorkspaceDotCardProps>): string {
    return renderToStaticMarkup(
        <WorkspaceDotCard name="Notulia" stops={["#e5484d"]} project={null} attention={[]} keys="" {...props} />
    );
}

function texts(html: string, testId: string): string[] {
    const re = new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`, "g");
    return Array.from(html.matchAll(re), (m) => m[1]);
}

describe("the popover's content", () => {
    it("shows the name, the colour mark, the project folder and its type", () => {
        const project = dotPopoverProject({
            meta: { "molten:project": "/Users/me/code/notulia-app", "molten:projecttype": "Desktop" },
        });
        expect(project).toEqual({ name: "notulia-app", type: "Desktop" });
        const html = card({ project });
        expect(texts(html, "sidebar-dot-popover-name")).toEqual(["Notulia"]);
        expect(html).toContain('data-testid="sidebar-dot-popover-mark"');
        expect(html).toContain("--mt-place:#e5484d");
        expect(texts(html, "sidebar-dot-popover-project")).toEqual(["notulia-app · Desktop"]);
    });

    it("shows the folder alone when the project has no type", () => {
        const project = dotPopoverProject({ meta: { "molten:project": "/srv/api" } });
        expect(texts(card({ project }), "sidebar-dot-popover-project")).toEqual(["api"]);
    });

    it("shows no project line for a workspace without a project", () => {
        expect(dotPopoverProject({ meta: {} })).toBeNull();
        expect(dotPopoverProject(null)).toBeNull();
        expect(card({ project: null })).not.toContain("sidebar-dot-popover-project");
    });

    it("lists what needs attention: unread, an agent waiting, kept awake", () => {
        const attention = ["2 unread", "Claude is waiting for you", "kept awake for 1 h"];
        expect(texts(card({ attention }), "sidebar-dot-popover-attention")).toEqual(attention);
        expect(card({ attention: [] })).not.toContain("sidebar-dot-popover-attention");
    });

    it("shows the jump key when the dot has one, per platform", () => {
        expect(texts(card({ keys: formatKeys(workspaceJumpKeys(3, true), true) }), "sidebar-dot-popover-keys")).toEqual(
            ["⌥3"]
        );
        expect(
            texts(card({ keys: formatKeys(workspaceJumpKeys(3, false), false) }), "sidebar-dot-popover-keys")
        ).toEqual(["Ctrl+Alt+3"]);
        expect(card({ keys: "" })).not.toContain("sidebar-dot-popover-keys");
    });
});

describe("why a dot rings (#2265)", () => {
    const text = (locale: string) => ({
        t: (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
        tc: (key: string, count: number) => translateCount(locale, key, count),
    });
    const quiet = { unread: 0, waitingAgent: null, waitingMessage: "", working: 0, keptAwake: null };

    it("says an agent waits first, then what it asks, then the unread notifications", () => {
        const lines = dotAttention(
            { ...quiet, unread: 3, waitingAgent: "Olivia", waitingMessage: "Allow the edit?", working: 1 },
            text("en")
        );
        expect(lines).toEqual(["Olivia waits for you", "Allow the edit?", "3 unread notifications", "1 agent at work"]);
    });

    it("names no one when the waiting agent has no name, and counts one notification", () => {
        expect(dotAttention({ ...quiet, waitingAgent: "" }, text("en"))).toEqual(["An agent waits for you"]);
        expect(dotAttention({ ...quiet, unread: 1 }, text("en"))).toEqual(["1 unread notification"]);
    });

    it("says the same in French", () => {
        expect(dotAttention({ ...quiet, unread: 2, waitingAgent: "Olivia" }, text("fr"))).toEqual([
            "Olivia vous attend",
            "2 notifications non lues",
        ]);
        expect(dotAttention({ ...quiet, waitingAgent: "" }, text("fr"))).toEqual(["Un agent vous attend"]);
    });

    it("says nothing for a dot at rest", () => {
        expect(dotAttention(quiet, text("en"))).toEqual([]);
    });

    it("gives the dot's popover and its accessible name the same lines", () => {
        const source = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
        const start = source.indexOf("function WorkspaceDot(");
        const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
        expect(body).toContain("const attention = dotAttention(");
        expect(body).toContain('const label = [entry.name, ...attention].join(" · ");');
        expect(body).toContain("attention={attention}");
    });
});

describe("when the popover shows", () => {
    it("shows for a hovered dot that is not the current workspace", () => {
        expect(dotShowsPopover({ hovered: true, dragging: false, current: false, attention: 0 })).toBe(true);
        expect(dotShowsPopover({ hovered: false, dragging: false, current: false, attention: 0 })).toBe(false);
    });

    it("hides while a dot is dragged", () => {
        expect(dotShowsPopover({ hovered: true, dragging: true, current: false, attention: 2 })).toBe(false);
    });

    it("shows for the current workspace only with something to say", () => {
        expect(dotShowsPopover({ hovered: true, dragging: false, current: true, attention: 0 })).toBe(false);
        expect(dotShowsPopover({ hovered: true, dragging: false, current: true, attention: 1 })).toBe(true);
    });
});

describe("the hover's timing", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("waits on the first dot, then moves along the row at once, and cools down off the row", () => {
        vi.useFakeTimers();
        const shown: string[] = [];
        const hover = new DotPopoverHover((id) => shown.push(id), 150);
        hover.enter("a");
        expect(shown).toEqual([]);
        vi.advanceTimersByTime(150);
        expect(shown).toEqual(["a"]);
        hover.out();
        hover.enter("b");
        expect(shown).toEqual(["a", null, "b"]);
        hover.leave();
        hover.enter("c");
        expect(shown).toEqual(["a", null, "b", null]);
        vi.advanceTimersByTime(150);
        expect(shown).toEqual(["a", null, "b", null, "c"]);
    });

    it("shows nothing when the pointer leaves before the delay", () => {
        vi.useFakeTimers();
        const shown: string[] = [];
        const hover = new DotPopoverHover((id) => shown.push(id), 150);
        hover.enter("a");
        hover.leave();
        vi.advanceTimersByTime(1000);
        expect(shown).toEqual([]);
    });
});

describe("the dot itself", () => {
    const source = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
    const start = source.indexOf("function WorkspaceDot(");
    const body = source.slice(start, source.indexOf("\nfunction ", start + 1));

    it("has no native title, keeps its aria-label and opens on hover and focus", () => {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(body).not.toMatch(/\btitle=\{/);
        expect(body).toContain("aria-label={label}");
        expect(body).toContain("onPointerEnter={hover.onEnter}");
        expect(body).toContain("onFocus={hover.onEnter}");
    });
});

describe("the popover never blocks", () => {
    const source = fs.readFileSync(path.join(__dirname, "workspace-dot-popover.tsx"), "utf8");

    it("lets the pointer through and stays out of the accessibility tree", () => {
        expect(source).toContain("pointer-events-none");
        expect(source).toContain("aria-hidden");
    });
});
