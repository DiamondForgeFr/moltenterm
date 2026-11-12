// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttachMarginPx, farEnd, RopePx } from "../tether/tether-model";
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
    BlockChromePx,
    BlockHeightPx,
    brainstormLayout,
    BrainstormPanelMinPx,
    BrainstormSquareMinPx,
    BrainstormTalkFloorPx,
    BrainstormTalkMaxPx,
    brainstormWidth,
    ConversationChromePx,
    conversationHeight,
    ConversationMaxPx,
    ConversationMinPx,
    conversationWidth,
    DefaultPanel,
    EdgePx,
    fallbackPanel,
    GroupDurations,
    groupFlow,
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
    LinkPx,
    neighbourPanel,
    openingPanel,
    panelHeight,
    PanelId,
    panelRoom,
    PanelSlidePx,
    panelWidth,
    PanelWidthPx,
    partMotion,
    plinkLine,
    PriorityFacts,
    priorityFactsOf,
    RailBorderPx,
    railCountTotal,
    RailInput,
    railMarks,
    RailPanels,
    Rect,
    reportCut,
    reportGrowth,
    ReportLines,
    reportRoom,
    ReportSize,
    reportView,
    SquarePx,
    TilePx,
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

    it("stacks the rail top to bottom: notifications, downloads, keep awake, agents, sessions (AC60, #2108)", () => {
        const g = groupGeometry();
        expect(RailPanels).toEqual(["notifications", "downloads", "keepawake", "agents", "sessions"]);
        const tops = RailPanels.map((id) => g.icons[id].y);
        expect(tops).toEqual([...tops].sort((a, b) => a - b));
    });

    it("works the gap out again for another square or tile", () => {
        const g = groupGeometry(300, 40);
        expect(g.gap).toBe((300 - 12 - 200) / 4);
        const last = g.icons[RailPanels[RailPanels.length - 1]];
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

    // The usage grid's height with n providers, as usage-week.css lays it out: 2 px padding above and below, the 11 px
    // initials, then per row a 7 px gap and the 18 px logo.
    const usageGridPx = (n: number) => 4 + 11 + n * (7 + 18);

    it("keeps every usage row above the field, for 1, 2 and 3 providers (AC57, #2106)", () => {
        for (const n of [1, 2, 3]) {
            const usage = usageGridPx(n);
            const g = groupGeometry(SquarePx, TilePx, usage);
            const lastRowBottom = g.block.y + BlockChromePx - 10 - 1 + usage;
            expect(g.block.h, `${n} providers`).toBeGreaterThanOrEqual(BlockChromePx + usage);
            expect(g.field.y, `${n} providers`).toBeGreaterThanOrEqual(lastRowBottom + 10 + 1 + EdgePx);
            expect(g.field.y).toBe(g.block.y + g.block.h + EdgePx);
            const flow = groupFlow(g, 40);
            expect(flow.field.y).toBe(g.field.y + 40);
        }
        expect(groupGeometry(SquarePx, TilePx, usageGridPx(3)).field.y).toBeGreaterThan(
            groupGeometry(SquarePx, TilePx, usageGridPx(2)).field.y
        );
    });

    it("counts in the card's chrome what brokk-group.css gives it", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        const block = /\n\.mt-brokk-block \{([^}]*)\}/.exec(css)[1];
        expect(block).toContain("gap: 9px;");
        expect(block).toContain("padding: 10px 12px;");
        expect(block).toContain("border: 1px solid");
        expect(/\.mt-brokk-say \{([^}]*)\}/.exec(css)[1]).toContain("min-height: 34px;");
        expect(BlockChromePx).toBe(10 * 2 + 1 * 2 + 34 + 9);
        expect(/\.mt-brokk-usage \{([^}]*)\}/.exec(css)[1]).not.toMatch(/max-height|overflow/);
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
        const pinned = afterClick("sessions");
        expect(activePanel(pinned, "agents")).toBe("sessions");
        expect(activePanel(afterHover(pinned, "downloads"), "agents")).toBe("downloads");
        expect(activePanel(afterHover(afterHover(pinned, "downloads"), null), "agents")).toBe("sessions");
    });

    it("pins a panel on a click on its icon, and keeps it on a second click, like a tab (#2090)", () => {
        const pinned = afterClick("downloads");
        expect(pinned).toEqual({ pinned: "downloads", hover: null });
        const again = afterClick("downloads");
        expect(activePanel(again, "notifications")).toBe("downloads");
        const opening = afterClick("notifications");
        expect(activePanel(opening, "notifications")).toBe("notifications");
    });

    it("pins a previewed panel on a click on its icon", () => {
        const pinned = afterClick("sessions");
        expect(activePanel(afterHover(pinned, null), "agents")).toBe("sessions");
    });

    it("shows what a surface asked for, pinned", () => {
        expect(activePanel(afterRequest("downloads"), "notifications")).toBe("downloads");
    });

    it("has no usage panel: the group's panels are the rail's (AC58, #2106)", () => {
        expect(RailPanels).not.toContain("usage");
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
    });

    it("never opens on the former usage detail, even when it was used last (AC58, #2106)", () => {
        expect(groupOpeningPanel(Quiet, "usage" as PanelId)).toBe("notifications");
        expect(groupOpeningPanel({ ...Quiet, downloadRunning: true }, "usage" as PanelId)).toBe("downloads");
    });

    it("opens the notifications with nothing to say and nothing used yet, never none (AC60, #2108)", () => {
        expect(groupOpeningPanel(Quiet, null)).toBe(DefaultPanel);
        expect(DefaultPanel).toBe("notifications");
        expect(activePanel(InitialPanels, groupOpeningPanel(Quiet, null))).toBe("notifications");
    });

    it("switches to another panel when the open one is closed: the opening one, else Notifications, else the next in the rail (AC60, #2108)", () => {
        expect(activePanel(afterClose("sessions", "downloads"), "downloads")).toBe("downloads");
        expect(activePanel(afterClose("downloads", "downloads"), "downloads")).toBe("notifications");
        expect(activePanel(afterClose("agents", "agents"), "agents")).toBe("notifications");
        expect(activePanel(afterClose("notifications", "notifications"), "notifications")).toBe("downloads");
        for (const closed of RailPanels) {
            for (const auto of RailPanels) {
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

// FR-BOSS-009, AC43 (#2097): the whole report is shown by the card growing, in the group's flow, never by a copy laid
// over it, and nothing of the group meets the panel.
describe("the report's card grows in the group's flow (layout as data)", () => {
    const g = groupGeometry();
    // Five lines of 17 px, two of them kept at rest.
    const Whole: ReportSize = { full: 85, shown: 34 };
    const Fits: ReportSize = { full: 34, shown: 34 };
    const Room = 784;
    const meets = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    it("keeps the lines the card shows at rest as the CSS clamp does", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(ReportLines).toBe(2);
        expect(css).toMatch(new RegExp(`-webkit-line-clamp: ${ReportLines};`));
    });

    it("leaves the group's room under it as the most the card can grow by", () => {
        expect(reportRoom(g, Room)).toBe(Room - (g.field.y + g.field.h));
        expect(reportRoom(g, 100)).toBe(0);
    });

    it("grows by what the text needs past the kept lines, and by nothing for a report that fits", () => {
        expect(reportGrowth(Whole, 372)).toBe(51);
        expect(reportGrowth(Fits, 372)).toBe(0);
        expect(reportGrowth({ full: 17, shown: 34 }, 372)).toBe(0);
        expect(reportGrowth({ full: 35, shown: 34 }, 372)).toBe(0);
    });

    it("stops at the room under the group, and never grows backwards", () => {
        expect(reportGrowth(Whole, 20)).toBe(20);
        expect(reportGrowth(Whole, 0)).toBe(0);
        expect(reportGrowth(Whole, -5)).toBe(0);
    });

    it("keeps the kept lines at rest, and draws no growth until it is pointed at", () => {
        expect(reportView(g, Whole, false, Room)).toEqual({ cut: true, open: false, growth: 0, textHeight: 34 });
    });

    it("makes the text as tall as the whole report once it is pointed at", () => {
        expect(reportView(g, Whole, true, Room)).toEqual({ cut: true, open: true, growth: 51, textHeight: 85 });
    });

    it("changes nothing for a report that fits, pointed at or not", () => {
        const rest = { cut: false, open: false, growth: 0, textHeight: null };
        expect(reportView(g, Fits, false, Room)).toEqual(rest);
        expect(reportView(g, Fits, true, Room)).toEqual(rest);
        expect(reportView(g, { full: 0, shown: 0 }, true, Room)).toEqual(rest);
    });

    it("scrolls the text in the card when the window has no more room for it", () => {
        const tight = g.field.y + g.field.h + 20;
        expect(reportView(g, Whole, true, tight)).toEqual({ cut: true, open: true, growth: 20, textHeight: 54 });
        expect(reportView(g, Whole, true, g.field.y)).toMatchObject({ growth: 0, textHeight: 34 });
    });

    it("is the group at rest when the card has not grown", () => {
        expect(groupFlow(g, 0)).toEqual({ block: g.block, field: g.field, height: g.field.y + g.field.h });
    });

    it("pushes what is under the card down by what the card grew, keeping the 8 px between them", () => {
        for (const growth of [1, 17, 51, 120, 372]) {
            const flow = groupFlow(g, growth);
            expect(flow.block).toEqual({ ...g.block, h: g.block.h + growth });
            expect(flow.field).toEqual({ ...g.field, y: g.field.y + growth });
            expect(flow.block.y + flow.block.h + EdgePx).toBe(flow.field.y);
            expect(flow.height).toBe(flow.field.y + flow.field.h);
        }
    });

    it("never pulls the group up", () => {
        expect(groupFlow(g, -40)).toEqual(groupFlow(g, 0));
    });

    it("never lets the grown card, the field under it and the panel meet", () => {
        for (const growth of [0, 17, 51, 120, 372]) {
            for (const conversation of [false, true]) {
                const flow = groupFlow(g, growth);
                const room = panelRoom(g, Room, conversation);
                const panel: Rect = {
                    x: g.panelLeft,
                    y: 0,
                    w: panelWidth(600),
                    h: panelHeight(5000, room, Math.min(g.square, room)),
                };
                const field: Rect = conversation ? { ...flow.field, w: conversationWidth(g, 600), h: 300 } : flow.field;
                const label = `growth ${growth}, conversation ${conversation}`;
                expect(meets(panel, flow.block), label).toBe(false);
                expect(meets(panel, field), label).toBe(false);
                expect(meets(flow.block, field), label).toBe(false);
                expect(flow.block.x + flow.block.w, label).toBeLessThan(panel.x);
                if (conversation) {
                    expect(field.y - (panel.y + panel.h), label).toBeGreaterThanOrEqual(EdgePx);
                }
            }
        }
    });

    it("leaves the panel still while the card grows: it is capped by the field's resting top", () => {
        expect(panelRoom(g, Room, true)).toBe(g.field.y - EdgePx);
        expect(panelRoom(g, Room, false)).toBe(Room);
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
        // The roomy input of #2285: the rule, the row's padding, two lines of the field and the footer.
        expect(ConversationChromePx).toBe(121);
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).toMatch(/\.mt-brokk-convo \{[^}]*padding: 14px 16px 8px;/);
        expect(css).toMatch(/\.mt-brokk-field\[data-open="true"\] \.mt-brokk-field-input \{[^}]*min-height: 52px;/);
        expect(css).toMatch(/\.mt-brokk-field-foot \{[^}]*height: 36px;/);
    });
});

// FR-BOSS-010 AC23 (#2285, decided on the PR): in a brainstorm the talk window takes about 45 % of the window, at most
// 764 px, at least what keeps the input usable (about 420 px), never past the window's room; the graph keeps the rest.
describe("the brainstorm's talk window width", () => {
    const g = groupGeometry();
    const placeIn = (windowWidth: number, heightRoom = 900) => groupPlace(null, { width: windowWidth, height: 980 }, g);

    it("takes 45 % of the window, at most 764 px and at least about 420 px", () => {
        expect(BrainstormTalkMaxPx).toBe(764);
        expect(BrainstormTalkMaxPx).toBe(conversationWidth(g, PanelWidthPx));
        expect(brainstormWidth(2560, 5000)).toBe(764);
        expect(brainstormWidth(1440, 5000)).toBe(648);
        expect(brainstormWidth(1200, 5000)).toBe(540);
        expect(brainstormWidth(800, 5000)).toBe(BrainstormTalkFloorPx);
        expect(brainstormWidth(1440, 500)).toBe(500);
        // Never so narrow that his square and a usable panel no longer fit side by side.
        expect(brainstormWidth(300, 200)).toBe(BrainstormSquareMinPx + 8 + BrainstormPanelMinPx);
    });

    it("leaves the rest of the window to the graph, whatever its width", () => {
        for (const width of [900, 1100, 1280, 1440, 1728, 2560]) {
            const place = placeIn(width);
            const bs = brainstormLayout(g, place);
            expect(bs.width, `${width}`).toBeLessThanOrEqual(Math.max(BrainstormTalkFloorPx, Math.round(width * 0.45)));
            expect(bs.width, `${width}`).toBeLessThanOrEqual(764);
            expect(place.left + bs.width, `${width}`).toBeLessThan(width);
            expect(width - place.left - bs.width, `${width}`).toBeGreaterThanOrEqual(width * 0.5);
        }
    });

    it("gives some of his square to a narrow window, so that the panel beside it stays usable", () => {
        const wide = brainstormLayout(g, placeIn(1440));
        expect(wide.square).toBe(SquarePx);
        expect(wide.panel.w).toBe(648 - SquarePx - 8);
        const narrow = brainstormLayout(g, placeIn(1000));
        expect(narrow.width).toBe(450);
        expect(narrow.square).toBe(450 - 8 - BrainstormPanelMinPx);
        expect(narrow.panel).toEqual({ x: narrow.square + 8, y: 0, w: BrainstormPanelMinPx, h: narrow.square });
        expect(narrow.talk.y).toBe(narrow.square + 8);
        const floor = brainstormLayout(g, placeIn(700));
        expect(floor.width).toBe(BrainstormTalkFloorPx);
        expect(floor.square).toBe(BrainstormTalkFloorPx - 8 - BrainstormPanelMinPx);
        const smallest = brainstormLayout(g, placeIn(420));
        expect(smallest.square).toBe(BrainstormSquareMinPx);
        expect(smallest.panel.w).toBe(BrainstormPanelMinPx);
    });
});

describe("keys between the icons", () => {
    it("moves down and up the rail and wraps", () => {
        expect(neighbourPanel("notifications", "ArrowDown")).toBe("downloads");
        expect(neighbourPanel("keepawake", "ArrowDown")).toBe("agents");
        expect(neighbourPanel("sessions", "ArrowDown")).toBe("notifications");
        expect(neighbourPanel("notifications", "ArrowUp")).toBe("sessions");
        expect(neighbourPanel("agents", "Home")).toBe("notifications");
        expect(neighbourPanel("agents", "End")).toBe("sessions");
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
        expect(holdsHover(afterClick("agents"))).toBe(false);
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
        // The brainstorm panel in the rail's place (#2285) arrives as the rail does.
        const parts = rule(".mt-brokk-sq,\n.mt-brokk-rail,\n.mt-brokk-bspanel,\n.mt-brokk-block,\n.mt-brokk-fieldbox");
        expect(parts).toMatch(/transform var\(--mt-duration-snap\) cubic-bezier\(0\.3, 1\.12, 0\.4, 1\),/);
        expect(parts).toMatch(/opacity var\(--mt-duration-show\) linear;/);
        const stepped = rule(
            ".mt-brokk-group.is-in > .mt-brokk-rail,\n.mt-brokk-group.is-in > .mt-brokk-bspanel,\n.mt-brokk-group.is-in > .mt-brokk-block"
        );
        expect(stepped).toMatch(
            /transform var\(--mt-duration-snap\) cubic-bezier\(0\.3, 1\.12, 0\.4, 1\) calc\(var\(--i, 0\) \* 50ms\)/
        );
        expect(stepped).toMatch(/opacity var\(--mt-duration-show\) linear calc\(var\(--i, 0\) \* 50ms\)/);
        const panel = rule(".mt-brokk-gpanel");
        expect(panel).toMatch(/opacity: 0;/);
        // It comes out of the rail's edge, the whole gap back (#2196, AC66), on the curve of its tether (AC67).
        expect(panel).toMatch(new RegExp(`transform: translateX\\(-${PanelSlidePx}px\\);`));
        expect(panel).toMatch(/transform var\(--mt-duration-settle\) var\(--mt-ease-tether\),/);
        expect(panel).toMatch(/opacity var\(--mt-duration-base\) linear,/);
        expect(panel).not.toMatch(/animation:/);
        const panelIn = rule(".mt-brokk-group.is-in > .mt-brokk-gpanel");
        expect(panelIn).toMatch(/opacity: 1;/);
        // A keyframe animation on the panel would keep the leaving transition from starting: it would vanish at once.
        expect(css).not.toMatch(/\.mt-brokk-(gpanel|plink)[^{]*\{[^}]*animation: (?!none)/);
        expect(css).toMatch(
            new RegExp(
                `@starting-style \\{\\s*\\.mt-brokk-group\\.is-in > \\.mt-brokk-gpanel \\{\\s*opacity: 0;\\s*transform: translateX\\(-${PanelSlidePx}px\\);`
            )
        );
        // Its link is the tether's (tether.css), which plays the panel's time and curve by default and the square's for the
        // thread: nothing of it is left in this sheet but that choice.
        expect(css).not.toMatch(/\.mt-brokk-plink/);
        const thread = rule(".mt-tether.mt-brokk-thread");
        expect(thread).toMatch(/--mt-tether-time: var\(--mt-duration-drop\);/);
        expect(thread).toMatch(/--mt-tether-ease: cubic-bezier\(0\.2, 1\.15, 0\.4, 1\);/);
        expect(thread).toMatch(/--mt-tether-fade: var\(--mt-duration-show\);/);
        const tether = readFileSync(join(__dirname, "..", "tether", "tether.css"), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        const tetherDefaults = new RegExp("\\n\\.mt-tether \\{([^}]*)\\}").exec(tether)?.[1] ?? "";
        expect(tetherDefaults).toMatch(/--mt-tether-time: var\(--mt-duration-settle\);/);
        expect(tetherDefaults).toMatch(/--mt-tether-ease: var\(--mt-ease-tether\);/);
        expect(tetherDefaults).toMatch(/--mt-tether-fade: var\(--mt-duration-base\);/);
        expect(tokens).toContain("--mt-ease-tether: cubic-bezier(0.25, 1.5, 0.4, 1);");
        // Nothing waits on the way out: only the arriving rules carry a step.
        for (const leaving of [square, parts, panel, thread, rule(".mt-brokk-fieldbox")]) {
            expect(leaving).not.toMatch(/calc\(var\(--i/);
        }
    });
});

describe("the tether of the open panel's icon (FR-BOSS-009, AC65 to AC68, #2196)", () => {
    const g = groupGeometry();

    it("comes out of the rail's edge: the panel starts the whole gap back", () => {
        expect(PanelSlidePx).toBe(LinkPx);
        expect(g.panelLeft - PanelSlidePx).toBe(g.width);
    });

    it("is tied on each icon's edge at its middle and reaches the panel's edge, the rail's border counted", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(/\n\.mt-brokk-rail \{([^}]*)\}/.exec(css)?.[1]).toMatch(new RegExp(`border: ${RailBorderPx}px solid`));
        for (const id of RailPanels) {
            const icon = g.icons[id];
            const line = plinkLine(g, id, SquarePx);
            expect(line.left, id).toBe(icon.x + icon.w + RailBorderPx);
            expect(line.top + RopePx / 2, id).toBe(icon.y + icon.h / 2 + RailBorderPx);
            expect(line.left + line.width, id).toBe(g.panelLeft);
        }
    });

    it("keeps its far end on the panel's edge at every moment of the slide, the give included", () => {
        const line = plinkLine(g, "notifications", SquarePx);
        for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 1, 1.08]) {
            const panelEdge = g.panelLeft - PanelSlidePx * (1 - progress);
            expect(farEnd(line, progress)).toBeCloseTo(panelEdge, 9);
        }
    });

    it("starts at the rail's edge and is whole once the panel is in", () => {
        const line = plinkLine(g, "agents", SquarePx);
        expect(line.from).toBeGreaterThan(0);
        expect(line.from).toBeLessThan(1);
        expect(farEnd(line, 0)).toBe(g.width);
        expect(farEnd(line, 1)).toBe(g.panelLeft);
    });

    it("is held on the panel's edge when the window leaves the panel less height than the icon's level", () => {
        const icon = g.icons.sessions;
        expect(icon.y + icon.h / 2).toBeGreaterThan(120);
        const line = plinkLine(g, "sessions", 120);
        expect(line.top + RopePx / 2).toBe(120 - AttachMarginPx);
    });
});
