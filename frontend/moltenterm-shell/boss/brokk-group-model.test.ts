// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    activePanel,
    afterClick,
    afterClose,
    afterHover,
    afterRequest,
    arrivalOffset,
    ArrivalStepMs,
    ArrivalSteps,
    badgeShares,
    BlockHeightPx,
    ConversationChromePx,
    conversationHeight,
    ConversationMaxPx,
    ConversationMinPx,
    conversationWidth,
    DefaultPanel,
    fallbackPanel,
    GroupDurations,
    groupGeometry,
    groupOpeningPanel,
    GroupParts,
    groupPlace,
    holdsHover,
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
    panelRoom,
    panelWidth,
    partMotion,
    PriorityFacts,
    priorityFactsOf,
    railCountTotal,
    RailInput,
    railMarks,
    RailPanels,
    Rect,
    reportCut,
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

    // As the app measures them (#2082): the sidebar ends where the layer starts, and the panels start 8 px into it.
    const Layer = { width: 1364, height: 984 };
    const Gap = 8;
    const g = groupGeometry();

    it("stands 8 px from the window area's edge and top, not on the corner of its panels (#2082)", () => {
        const open = groupPlace({ x: -264, y: 0, w: 264, h: 984 }, Layer, g, Gap);
        expect(open.left).toBe(Gap + 8);
        expect(open.top).toBe(Gap + 8);
        expect(open.heightRoom).toBe(984 - 2 * (Gap + 8));
        expect(open.panelRoom).toBe(1364 - open.left - g.panelLeft - Gap - 8);
    });

    it("takes the sidebar's real right edge when it reaches further than the frame: its left is that edge plus 8", () => {
        for (const right of [0, 22, 30, 264]) {
            const place = groupPlace({ x: right - 264, y: 0, w: 264, h: 984 }, Layer, g, Gap);
            expect(place.left, `edge at ${right}`).toBe(Math.max(right, Gap) + 8);
            expect(place.left - Math.max(right, Gap)).toBe(8);
        }
        // The strip of a collapsed sidebar (#2070) is measured as a sidebar of no width at the layer's left.
        expect(groupPlace({ x: 0, y: 0, w: 0, h: 984 }, Layer, g, Gap).left).toBe(Gap + 8);
    });

    it("keeps the gap at every window size", () => {
        for (const layer of [
            { width: 700, height: 500 },
            { width: 1364, height: 984 },
            { width: 2500, height: 1400 },
        ]) {
            const place = groupPlace({ x: -264, y: 0, w: 264, h: layer.height }, layer, g, Gap);
            expect(place.left).toBe(Gap + 8);
            expect(place.top).toBe(Gap + 8);
            expect(place.top + place.heightRoom).toBe(layer.height - Gap - 8);
        }
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
    it("shows the panel the group opened with when nothing is pinned or previewed", () => {
        expect(activePanel(InitialPanels, "agents")).toBe("agents");
    });

    it("shows one panel at a time: a preview wins over the pinned one, the pinned one over the opening one", () => {
        const pinned = afterClick(InitialPanels, "sessions", "agents", "agents");
        expect(activePanel(pinned, "agents")).toBe("sessions");
        expect(activePanel(afterHover(pinned, "downloads"), "agents")).toBe("downloads");
        expect(activePanel(afterHover(afterHover(pinned, "downloads"), null), "agents")).toBe("sessions");
    });

    it("pins a panel on a click on its icon, and keeps it on a second click, like a tab (#2090)", () => {
        const pinned = afterClick(InitialPanels, "downloads", "notifications", "notifications");
        expect(pinned).toEqual({ pinned: "downloads", hover: null });
        const again = afterClick(pinned, "downloads", "downloads", "notifications");
        expect(activePanel(again, "notifications")).toBe("downloads");
        const opening = afterClick(InitialPanels, "notifications", "notifications", "notifications");
        expect(activePanel(opening, "notifications")).toBe("notifications");
    });

    it("pins a previewed panel on a click on its icon", () => {
        const previewing = afterHover(InitialPanels, "sessions");
        const pinned = afterClick(previewing, "sessions", "sessions", "agents");
        expect(activePanel(afterHover(pinned, null), "agents")).toBe("sessions");
    });

    it("shows what a surface asked for, pinned", () => {
        expect(activePanel(afterRequest("downloads"), "notifications")).toBe("downloads");
    });

    it("pins the usage detail from its toggle, and a second click switches to another panel, never to none", () => {
        const usage = afterClick(InitialPanels, "usage", "agents", "agents");
        expect(activePanel(usage, "agents")).toBe("usage");
        expect(activePanel(afterClick(usage, "usage", "usage", "agents"), "agents")).toBe("agents");
        expect(activePanel(afterClick(usage, "usage", "usage", "usage"), "usage")).toBe("agents");
    });
});

// #2090: a panel is always open while the group is; closing the group is the way to have none.
describe("a panel always open", () => {
    it("opens the priority's panel when it has something to say, whatever was used last", () => {
        expect(groupOpeningPanel({ ...Quiet, urgentOrAnswer: true }, "sessions")).toBe("notifications");
        expect(groupOpeningPanel({ ...Quiet, downloadRunning: true }, "keepawake")).toBe("downloads");
    });

    it("opens the panel used last when the priority has nothing to say", () => {
        expect(groupOpeningPanel(Quiet, "sessions")).toBe("sessions");
        expect(groupOpeningPanel(Quiet, "usage")).toBe("usage");
    });

    it("opens the agents with nothing to say and nothing used yet, never none", () => {
        expect(groupOpeningPanel(Quiet, null)).toBe(DefaultPanel);
        expect(DefaultPanel).toBe("agents");
        expect(activePanel(InitialPanels, groupOpeningPanel(Quiet, null))).toBe("agents");
    });

    it("switches to another panel when the open one is closed: the opening one, else the agents, else Notifications", () => {
        expect(activePanel(afterClose("sessions", "downloads"), "downloads")).toBe("downloads");
        expect(activePanel(afterClose("downloads", "downloads"), "downloads")).toBe("agents");
        expect(activePanel(afterClose("agents", "agents"), "agents")).toBe("notifications");
        for (const closed of [...RailPanels, "usage" as const]) {
            for (const auto of [...RailPanels, "usage" as const]) {
                const next = activePanel(afterClose(closed, auto), auto);
                expect(next).not.toBeNull();
                expect(next).not.toBe(closed);
            }
        }
    });

    it("pins the panel it switched to and forgets a preview, so it stays when the pointer leaves", () => {
        const previewing = afterHover(InitialPanels, "keepawake");
        const closed = afterClose(activePanel(previewing, "agents"), "agents");
        expect(closed).toEqual({ pinned: "agents", hover: null });
        expect(fallbackPanel("keepawake", "agents")).toBe("agents");
    });
});

// #2090: when the conversation window opens from the field's top over the panel area, the panel gives way above it.
describe("the panel and the grown field never overlap (layout as data)", () => {
    const g = groupGeometry();
    // The panel stands at the group's top (y 0): its bottom is its height, sized as the group sizes it.
    const panelBottom = (content: number, room: number, conversation: boolean) => {
        const r = panelRoom(g, room, conversation);
        return panelHeight(content, r, Math.min(g.square, r));
    };

    it("keeps the panel's bottom above the field's top, 8 px clear, however tall its content", () => {
        for (const content of [0, 264, 400, 900, 5000]) {
            expect(panelBottom(content, 784, true)).toBeLessThanOrEqual(g.field.y - 8);
        }
        expect(panelBottom(5000, 784, true)).toBe(g.field.y - 8);
    });

    it("lets a short panel keep its height: it only shrinks when it would reach the field", () => {
        expect(panelBottom(0, 784, true)).toBe(g.square);
        expect(panelBottom(300, 784, true)).toBe(300);
    });

    it("grows back to the window's room when the field folds", () => {
        expect(panelBottom(5000, 784, false)).toBe(784);
        expect(panelRoom(g, 784, false)).toBe(784);
    });

    it("never gives more room than the window has, nor less than none", () => {
        expect(panelRoom(g, 200, true)).toBe(200);
        expect(panelRoom(g, -5, true)).toBe(0);
    });

    it("leaves the field where it is: the conversation grows from the field's top", () => {
        expect(g.field.y).toBe(SquarePx + 8 + BlockHeightPx + 8);
    });
});

// #2090: the report under the square is cut at two lines; only a cut one shows the whole of it on hover or focus.
describe("the report's cut", () => {
    it("is cut when the text needs more than the card's two lines", () => {
        expect(reportCut(51, 34)).toBe(true);
    });

    it("is not cut when it fits, a rounding pixel included", () => {
        expect(reportCut(34, 34)).toBe(false);
        expect(reportCut(17, 34)).toBe(false);
        expect(reportCut(35, 34)).toBe(false);
    });
});

// FR-BOSS-009, AC22 (#2033): the conversation window grows from the field in place.
describe("the conversation window", () => {
    const g = groupGeometry();

    it("is as wide as the group and the panel area together, so it reaches the right edge where a panel stands", () => {
        expect(conversationWidth(g, 600)).toBe(g.panelLeft + 420);
        expect(conversationWidth(g, 600)).toBeGreaterThan(g.field.w);
    });

    it("is narrower only when the window is, as the panel is", () => {
        expect(conversationWidth(g, 330)).toBe(g.panelLeft + 330);
        expect(conversationWidth(g, 100)).toBe(g.panelLeft + 280);
    });

    it("is about 240 px tall when the exchange is short, and grows with it", () => {
        expect(conversationHeight(0, 800)).toBe(ConversationMinPx);
        expect(conversationHeight(120, 800)).toBe(ConversationMinPx);
        expect(conversationHeight(300, 800)).toBe(300);
    });

    it("stops growing at the most, then the exchange scrolls inside", () => {
        expect(conversationHeight(2000, 2000)).toBe(ConversationMaxPx);
    });

    it("stops at the window's room when that is smaller", () => {
        expect(conversationHeight(2000, 330)).toBe(330);
        expect(conversationHeight(100, 200)).toBe(200);
    });

    it("never goes under the field itself", () => {
        expect(conversationHeight(100, 10)).toBe(36);
    });

    it("starts at the field's top, under the block, in the group's own coordinates", () => {
        expect(g.field.y).toBe(g.block.y + g.block.h + 8);
        expect(ConversationChromePx).toBe(10 + 4 + 36 + 1 + 2);
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

    it("holds the pointer under the group only while a preview shows, so that a page tile cannot keep it open", () => {
        expect(holdsHover(InitialPanels)).toBe(false);
        expect(holdsHover(afterClick(InitialPanels, "agents", "notifications", "notifications"))).toBe(false);
        const previewing = afterHover(InitialPanels, "downloads");
        expect(holdsHover(previewing)).toBe(true);
        expect(holdsHover(afterHover(previewing, null))).toBe(false);
        expect(holdsHover(afterRequest("sessions"))).toBe(false);
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

const NoFacts: RailInput = {
    badgeKeys: [],
    urgentOrAnswer: false,
    unread: false,
    agentBlocked: false,
    downloadReported: false,
    downloadProgress: null as number,
    downloadRunning: false,
    keepAwake: false,
};

// The developer's gold, 2026-11-07 (#2085): a pull request ready to merge (PR #2080, "[#2070] Collapsed sidebar keeps
// Brokk at its edge…") made the badge's "1", and a download was running.
const ReadyPrKey = "ready:/Users/dev/moltenterm:2080";

describe("the priority read from the badge and the panel's facts (#2085)", () => {
    const opens = (input: Partial<RailInput>) => openingPanel(priorityFactsOf({ ...NoFacts, ...input }));

    it("1. opens Notifications when anything is grave or waits for an answer, whatever else there is", () => {
        expect(
            opens({
                urgentOrAnswer: true,
                agentBlocked: true,
                downloadReported: true,
                badgeKeys: ["download:d1", "agent:b"],
                downloadRunning: true,
            })
        ).toBe("notifications");
    });

    it("2. opens Agents when an agent is blocked and nothing waits for an answer", () => {
        expect(opens({ agentBlocked: true, badgeKeys: ["download:d1"], downloadRunning: true })).toBe("agents");
    });

    it("3. opens Téléchargements when a download finished or failed, before an unread notification", () => {
        expect(opens({ downloadReported: true, unread: true, downloadRunning: true })).toBe("downloads");
        expect(opens({ badgeKeys: ["download:d1", ReadyPrKey], downloadRunning: true })).toBe("downloads");
    });

    it("4. opens Notifications for an unread item of the badge while a download runs", () => {
        expect(opens({ badgeKeys: [ReadyPrKey], downloadRunning: true, downloadProgress: 0.4 })).toBe("notifications");
        expect(opens({ unread: true, downloadRunning: true })).toBe("notifications");
    });

    it("5. opens Téléchargements for a running download only when there is nothing else", () => {
        expect(opens({ downloadRunning: true, downloadProgress: 0.4 })).toBe("downloads");
        expect(opens({})).toBeNull();
    });
});

describe("the badge and the rail agree (#2085)", () => {
    it("puts every item of the badge on its own icon: the face's badge is the sum of the rail's counts", () => {
        const keys = [ReadyPrKey, "agent:b", "finished:c", "row:handoff:x", "update:1.0.1", "download:d1"];
        const marks = railMarks({ ...NoFacts, badgeKeys: keys, downloadRunning: true, downloadProgress: 0.5 });
        expect(marks.notifications.count).toBe(5);
        expect(marks.downloads.count).toBe(1);
        expect(railCountTotal(marks)).toBe(keys.length);
    });

    it("counts the ready pull request of the gold under Notifications", () => {
        const marks = railMarks({ ...NoFacts, badgeKeys: [ReadyPrKey], downloadRunning: true, downloadProgress: 0.4 });
        expect(marks.notifications.count).toBe(1);
        expect(railCountTotal(marks)).toBe(1);
    });

    it("counts nothing for a running download alone: it is the ring, not the badge", () => {
        const marks = railMarks({ ...NoFacts, downloadRunning: true, downloadProgress: 0.4 });
        expect(railCountTotal(marks)).toBe(0);
        expect(marks.downloads.ring).toBe(0.4);
        expect(badgeShares([])).toEqual({ notifications: 0, downloads: 0 });
    });

    it("shows a dot, not a count, for unread news the badge does not count", () => {
        const marks = railMarks({ ...NoFacts, unread: true });
        expect(marks.notifications).toMatchObject({ count: 0, dot: true });
        expect(railMarks({ ...NoFacts, unread: true, badgeKeys: ["agent:a"] }).notifications.dot).toBe(false);
    });
});

describe("the marks of the closed icons", () => {
    const base = NoFacts;

    it("counts the notifications, red when anything is grave or waits for an answer", () => {
        expect(
            railMarks({ ...base, badgeKeys: ["agent:a", "ci:/p:1", "row:q"], urgentOrAnswer: true }).notifications
        ).toMatchObject({
            count: 3,
            grave: true,
        });
        expect(railMarks({ ...base, badgeKeys: ["agent:a", "ready:/p:2"] }).notifications).toMatchObject({
            count: 2,
            grave: false,
        });
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

describe("the panel moves with the group (FR-BOSS-009, #2082)", () => {
    const start = (way: "open" | "close", reduced: boolean) =>
        Math.min(...GroupParts.map((p) => partMotion(p, way, reduced).start));
    const end = (way: "open" | "close", reduced: boolean) =>
        Math.max(...GroupParts.map((p) => partMotion(p, way, reduced).end));

    it("opens no earlier than the square: it shows with it, from the moment the group comes in", () => {
        const panel = partMotion("panel", "open", false);
        expect(panel.start).toBeGreaterThanOrEqual(partMotion("square", "open", false).start);
        expect(panel.start).toBeGreaterThanOrEqual(start("open", false));
    });

    it("is gone on close no later than the square, and so no later than the group", () => {
        const panel = partMotion("panel", "close", false);
        expect(panel.end).toBeLessThanOrEqual(partMotion("square", "close", false).end);
        expect(panel.end).toBeLessThanOrEqual(end("close", false));
        for (const part of [...GroupParts, "panel" as const]) {
            expect(partMotion(part, "close", false).start, part).toBe(0);
        }
    });

    it("takes the group's own short fade under reduced motion, both ways", () => {
        for (const way of ["open", "close"] as const) {
            expect(partMotion("panel", way, true)).toEqual(partMotion("square", way, true));
            expect(partMotion("panel", way, true)).toEqual({ start: 0, end: GroupDurations.fade });
        }
    });

    it("plays the approved mockup's curves, durations and steps", () => {
        // Exploration #2027: the square drops in .52 s, the rail, the strip and the field snap in .42 s a step of 50 ms
        // apart, they show in .2 s, the panel slides in .26 s and shows in .18 s.
        expect(GroupDurations).toEqual({ drop: 520, snap: 420, show: 200, settle: 260, base: 180, fade: 120 });
        expect(ArrivalSteps).toEqual({ square: 0, rail: 1, block: 1, field: 0, panel: 0 });
        expect(ArrivalStepMs).toBe(50);
    });

    it("is what the style sheet plays: the tokens, no delay to leave, the step to arrive", () => {
        const tokens = readFileSync(join(__dirname, "..", "tokens.css"), "utf8");
        for (const [name, ms] of Object.entries(GroupDurations)) {
            expect(tokens, name).toContain(`--mt-duration-${name}: ${ms}ms;`);
        }
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const rule = (selector: string) =>
            new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
        const square = rule(".mt-brokk-sq");
        expect(square).toMatch(/transform var\(--mt-duration-drop\) cubic-bezier\(0\.2, 1\.15, 0\.4, 1\),/);
        expect(square).toMatch(/opacity var\(--mt-duration-show\) linear;/);
        const parts = rule(".mt-brokk-sq,\n.mt-brokk-rail,\n.mt-brokk-block,\n.mt-brokk-fieldbox");
        expect(parts).toMatch(/transform var\(--mt-duration-snap\) cubic-bezier\(0\.3, 1\.12, 0\.4, 1\),/);
        expect(parts).toMatch(/opacity var\(--mt-duration-show\) linear;/);
        const stepped = rule(".mt-brokk-group.is-in > .mt-brokk-rail,\n.mt-brokk-group.is-in > .mt-brokk-block");
        expect(stepped).toMatch(
            /transform var\(--mt-duration-snap\) cubic-bezier\(0\.3, 1\.12, 0\.4, 1\) calc\(var\(--i, 0\) \* 50ms\)/
        );
        expect(stepped).toMatch(/opacity var\(--mt-duration-show\) linear calc\(var\(--i, 0\) \* 50ms\)/);
        const panel = rule(".mt-brokk-gpanel");
        expect(panel).toMatch(/opacity: 0;/);
        expect(panel).toMatch(/transform: translateX\(-8px\);/);
        expect(panel).toMatch(/transform var\(--mt-duration-settle\) cubic-bezier\(0\.3, 1\.12, 0\.4, 1\),/);
        expect(panel).toMatch(/opacity var\(--mt-duration-base\) linear,/);
        expect(panel).not.toMatch(/animation:/);
        const panelIn = rule(".mt-brokk-group.is-in > .mt-brokk-gpanel");
        expect(panelIn).toMatch(/opacity: 1;/);
        // A keyframe animation on the panel would keep the leaving transition from starting: it would vanish at once.
        expect(css).not.toMatch(/\.mt-brokk-(gpanel|plink)[^{]*\{[^}]*animation: (?!none)/);
        expect(css).toMatch(
            /@starting-style \{\s*\.mt-brokk-group\.is-in > \.mt-brokk-gpanel \{\s*opacity: 0;\s*transform: translateX\(-8px\);/
        );
        const link = rule(".mt-brokk-plink");
        expect(link).toMatch(/opacity: 0;/);
        expect(link).toMatch(/transition: opacity var\(--mt-duration-base\) linear;/);
        // Nothing waits on the way out: only the arriving rules carry a step.
        for (const leaving of [square, parts, panel, link, rule(".mt-brokk-fieldbox")]) {
            expect(leaving).not.toMatch(/calc\(var\(--i/);
        }
    });
});
