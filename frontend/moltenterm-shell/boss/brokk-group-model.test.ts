// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    activePanel,
    afterClick,
    afterHover,
    afterRequest,
    arrivalOffset,
    BlockHeightPx,
    groupGeometry,
    groupPlace,
    HoverCloseMs,
    HoverDeps,
    HoverIntent,
    HoverOpenMs,
    InitialPanels,
    inZone,
    neighbourPanel,
    openingPanel,
    panelHeight,
    PanelId,
    panelWidth,
    PriorityFacts,
    railMarks,
    RailPanels,
    Rect,
    SquarePx,
} from "./brokk-group-model";

const Quiet: PriorityFacts = {
    urgentOrAnswer: false,
    agentBlocked: false,
    downloadReported: false,
    unread: false,
    downloadRunning: false,
};

describe("the geometry of the group", () => {
    it("makes the rail exactly as tall as the square, with an 8 px gap by default", () => {
        const g = groupGeometry();
        expect(g.gap).toBe(8);
        expect(g.rail.h).toBe(SquarePx);
        const last = g.icons[RailPanels[RailPanels.length - 1]];
        expect(last.y + last.h + 6).toBe(SquarePx);
        expect(g.icons.notifications.y).toBe(6);
    });

    it("works the gap out again for another square or tile", () => {
        const g = groupGeometry(300, 40);
        expect(g.gap).toBe((300 - 12 - 200) / 4);
        const last = g.icons.keepawake;
        expect(last.y + last.h + 6).toBe(300);
    });

    it("is square + 8 + tile + 12 wide, with the block 8 px under the square and the field 8 px under the block", () => {
        const g = groupGeometry();
        expect(g.width).toBe(264 + 8 + 44 + 12);
        expect(g.block).toEqual({ x: 0, y: 272, w: g.width, h: BlockHeightPx });
        expect(g.field.y).toBe(272 + BlockHeightPx + 8);
        expect(g.field.w).toBe(g.width);
        expect(g.panelLeft).toBe(g.width + 16);
    });

    it("stands 8 px right of the sidebar and 8 px from the top, or 8 px from the left edge without a sidebar", () => {
        const g = groupGeometry();
        const withSidebar = groupPlace({ x: 0, y: 0, w: 264, h: 700 }, { width: 1400, height: 800 }, g);
        expect(withSidebar.left).toBe(272);
        expect(withSidebar.top).toBe(8);
        expect(withSidebar.heightRoom).toBe(784);
        expect(withSidebar.panelRoom).toBe(1400 - 272 - g.panelLeft - 8);
        expect(groupPlace(null, { width: 1400, height: 800 }, g).left).toBe(8);
    });

    it("computes the offset from a rect's middle to the face", () => {
        expect(arrivalOffset({ x: 239, y: 20 }, { x: 0, y: 0, w: 264, h: 264 })).toEqual({
            dx: 239 - 132,
            dy: 20 - 132,
        });
    });
});

describe("the height and the width of the panel", () => {
    it("is as tall as the square by default", () => {
        expect(panelHeight(120, 784)).toBe(SquarePx);
        expect(panelHeight(0, 784)).toBe(SquarePx);
    });

    it("grows past the square only as far as its content needs", () => {
        expect(panelHeight(400, 784)).toBe(400);
    });

    it("stops at the window and scrolls past it", () => {
        expect(panelHeight(2000, 784)).toBe(784);
        expect(panelHeight(2000, 200)).toBe(200);
    });

    it("is about 420 px, narrower only when the window is", () => {
        expect(panelWidth(900)).toBe(420);
        expect(panelWidth(350)).toBe(350);
        expect(panelWidth(100)).toBe(280);
    });
});

describe("the panel that opens by priority", () => {
    it("opens Notifications when anything is grave or waits for an answer, before anything else", () => {
        expect(
            openingPanel({ ...Quiet, urgentOrAnswer: true, agentBlocked: true, downloadReported: true, unread: true })
        ).toBe("notifications");
    });

    it("opens Agents when an agent is blocked and nothing waits for an answer", () => {
        expect(openingPanel({ ...Quiet, agentBlocked: true, downloadReported: true, unread: true })).toBe("agents");
    });

    it("opens Téléchargements when a download failed or just finished, before unread notifications", () => {
        expect(openingPanel({ ...Quiet, downloadReported: true, unread: true, downloadRunning: true })).toBe(
            "downloads"
        );
    });

    it("opens Notifications for anything else unread, before a running download", () => {
        expect(openingPanel({ ...Quiet, unread: true, downloadRunning: true })).toBe("notifications");
    });

    it("opens Téléchargements for a running download when that is all", () => {
        expect(openingPanel({ ...Quiet, downloadRunning: true })).toBe("downloads");
    });

    it("opens nothing when there is nothing to say", () => {
        expect(openingPanel(Quiet)).toBeNull();
    });
});

describe("which panel shows", () => {
    it("shows the priority panel when nothing is pinned or previewed", () => {
        expect(activePanel(InitialPanels, "agents", false)).toBe("agents");
        expect(activePanel(InitialPanels, null, false)).toBeNull();
    });

    it("shows one panel at a time: a preview wins over the pinned one, the pinned one over the priority", () => {
        const pinned = afterClick(InitialPanels, "sessions", "agents");
        expect(activePanel(pinned, "agents", false)).toBe("sessions");
        expect(activePanel(afterHover(pinned, "downloads"), "agents", false)).toBe("downloads");
        expect(activePanel(afterHover(afterHover(pinned, "downloads"), null), "agents", false)).toBe("sessions");
    });

    it("pins a panel on a click on its icon and closes the one that shows on a second click", () => {
        const pinned = afterClick(InitialPanels, "downloads", "notifications");
        expect(pinned).toEqual({ pinned: "downloads", hover: null, dismissed: false });
        const closed = afterClick(pinned, "downloads", "downloads");
        expect(activePanel(closed, "notifications", false)).toBeNull();
    });

    it("closes the panel the priority opened on a click on its icon", () => {
        const closed = afterClick(InitialPanels, "notifications", "notifications");
        expect(closed.dismissed).toBe(true);
        expect(activePanel(closed, "notifications", false)).toBeNull();
    });

    it("lets a hover bring a panel back after it was closed", () => {
        const closed = afterClick(InitialPanels, "notifications", "notifications");
        expect(activePanel(afterHover(closed, "agents"), "notifications", false)).toBe("agents");
    });

    it("shows what a surface asked for, pinned", () => {
        expect(activePanel(afterRequest("downloads"), "notifications", false)).toBe("downloads");
    });

    it("pins the usage detail the same way", () => {
        const usage = afterClick(InitialPanels, "usage", null);
        expect(activePanel(usage, "notifications", false)).toBe("usage");
        expect(activePanel(afterClick(usage, "usage", "usage"), "notifications", false)).toBeNull();
    });

    it("never overlaps the conversation: no panel shows while it is open, whatever is pinned, previewed or chosen", () => {
        const pinned = afterClick(InitialPanels, "sessions", null);
        expect(activePanel(pinned, "notifications", true)).toBeNull();
        expect(activePanel(afterHover(pinned, "agents"), "notifications", true)).toBeNull();
        expect(activePanel(InitialPanels, "notifications", true)).toBeNull();
    });

    it("brings the panel back when the conversation folds", () => {
        const pinned = afterClick(InitialPanels, "sessions", null);
        expect(activePanel(pinned, "notifications", true)).toBeNull();
        expect(activePanel(pinned, "notifications", false)).toBe("sessions");
    });
});

describe("keys between the icons", () => {
    it("moves down and up the rail and wraps", () => {
        expect(neighbourPanel("notifications", "ArrowDown")).toBe("agents");
        expect(neighbourPanel("keepawake", "ArrowDown")).toBe("notifications");
        expect(neighbourPanel("notifications", "ArrowUp")).toBe("keepawake");
        expect(neighbourPanel("agents", "Home")).toBe("notifications");
        expect(neighbourPanel("agents", "End")).toBe("keepawake");
        expect(neighbourPanel("agents", "a")).toBeNull();
    });
});

// A clock the tests turn by hand: nothing here waits.
function makeHover() {
    const timers: { run: () => void; ms: number; at: number; id: number }[] = [];
    let id = 0;
    let now = 0;
    const events: PanelId[] = [];
    let panel: Rect = { x: 0, y: 0, w: 0, h: 0 };
    const g = groupGeometry();
    const deps: HoverDeps = {
        geometry: () => g,
        panel: () => panel,
        setTimer: (run, ms) => {
            const t = { run, ms, at: now + ms, id: ++id };
            timers.push(t);
            return t.id;
        },
        clearTimer: (timer) => {
            const at = timers.findIndex((t) => t.id === timer);
            if (at >= 0) {
                timers.splice(at, 1);
            }
        },
        onHover: (hover) => events.push(hover),
    };
    const intent = new HoverIntent(deps);
    return {
        g,
        intent,
        events,
        setPanel: (rect: Rect) => (panel = rect),
        pending: () => timers.length,
        advance: (ms: number) => {
            now += ms;
            for (const t of [...timers].sort((a, b) => a.at - b.at)) {
                if (t.at <= now) {
                    timers.splice(timers.indexOf(t), 1);
                    t.run();
                }
            }
        },
    };
}

function centre(r: Rect) {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

describe("the hover that previews a panel", () => {
    it("opens a panel after 80 ms on its icon, not before", () => {
        const h = makeHover();
        const p = centre(h.g.icons.agents);
        h.intent.move(p.x, p.y);
        h.advance(HoverOpenMs - 1);
        expect(h.events).toEqual([]);
        h.advance(1);
        expect(h.events).toEqual(["agents"]);
    });

    it("opens nothing for a pointer that only passes over an icon", () => {
        const h = makeHover();
        const p = centre(h.g.icons.agents);
        h.intent.move(p.x, p.y);
        h.advance(HoverOpenMs - 10);
        h.intent.move(-50, 500);
        h.advance(1000);
        expect(h.events).toEqual([]);
    });

    it("folds the panel 250 ms after the pointer left its zone", () => {
        const h = makeHover();
        const icon = centre(h.g.icons.agents);
        h.intent.move(icon.x, icon.y);
        h.advance(HoverOpenMs);
        h.setPanel({ x: h.g.panelLeft, y: 0, w: 420, h: 264 });
        h.intent.move(icon.x, 900);
        h.advance(HoverCloseMs - 1);
        expect(h.events).toEqual(["agents"]);
        h.advance(1);
        expect(h.events).toEqual(["agents", null]);
    });

    it("does not flicker when the pointer crosses the link and enters the panel", () => {
        const h = makeHover();
        const icon = h.g.icons.agents;
        h.intent.move(icon.x + 5, icon.y + 5);
        h.advance(HoverOpenMs);
        h.setPanel({ x: h.g.panelLeft, y: 0, w: 420, h: 264 });
        h.intent.move(icon.x + icon.w + 4, icon.y + 5);
        h.intent.move(h.g.panelLeft + 2, icon.y + 5);
        h.intent.move(h.g.panelLeft + 100, 200);
        h.advance(5000);
        expect(h.events).toEqual(["agents"]);
        expect(inZone(h.g, "agents", { x: h.g.panelLeft, y: 0, w: 420, h: 264 }, h.g.panelLeft + 100, 200)).toBe(true);
    });

    it("keeps the panel when the pointer comes back before the delay ends", () => {
        const h = makeHover();
        const icon = centre(h.g.icons.agents);
        h.intent.move(icon.x, icon.y);
        h.advance(HoverOpenMs);
        h.intent.move(icon.x, 900);
        h.advance(HoverCloseMs - 50);
        h.intent.move(icon.x, icon.y);
        h.advance(5000);
        expect(h.events).toEqual(["agents"]);
    });

    it("goes from one icon to the next without folding in between", () => {
        const h = makeHover();
        const a = centre(h.g.icons.agents);
        const s = centre(h.g.icons.sessions);
        h.intent.move(a.x, a.y);
        h.advance(HoverOpenMs);
        h.intent.move(s.x, s.y);
        h.advance(HoverOpenMs);
        expect(h.events).toEqual(["agents", "sessions"]);
    });

    it("forgets everything when the group closes", () => {
        const h = makeHover();
        const a = centre(h.g.icons.agents);
        h.intent.move(a.x, a.y);
        h.advance(HoverOpenMs);
        h.intent.leave();
        h.intent.stop();
        expect(h.pending()).toBe(0);
        expect(h.intent.hover).toBeNull();
    });
});

describe("the marks of the closed icons", () => {
    const base = {
        noteCount: 0,
        urgentOrAnswer: false,
        agentBlocked: false,
        downloadReported: false,
        downloadProgress: null as number,
        downloadRunning: false,
        keepAwake: false,
    };

    it("counts the notifications, red when anything is grave or waits for an answer", () => {
        expect(railMarks({ ...base, noteCount: 3, urgentOrAnswer: true }).notifications).toMatchObject({
            count: 3,
            grave: true,
        });
        expect(railMarks({ ...base, noteCount: 2 }).notifications).toMatchObject({ count: 2, grave: false });
    });

    it("puts a dot on Agents when one is blocked", () => {
        expect(railMarks({ ...base, agentBlocked: true }).agents.dot).toBe(true);
        expect(railMarks(base).agents.dot).toBe(false);
    });

    it("runs a ring around Téléchargements while one downloads, and a dot once one is reported", () => {
        expect(railMarks({ ...base, downloadRunning: true, downloadProgress: 0.62 }).downloads.ring).toBe(0.62);
        expect(railMarks({ ...base, downloadRunning: true, downloadProgress: null }).downloads.ring).toBe(-1);
        expect(railMarks({ ...base, downloadReported: true }).downloads).toMatchObject({ dot: true, ring: null });
    });

    it("shows the cup's ember on Garder éveillé while the computer is kept awake", () => {
        expect(railMarks({ ...base, keepAwake: true }).keepawake.ember).toBe(true);
    });
});
