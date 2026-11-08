// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's floating group (FR-BOSS-009, AC17 and AC18, #2032): the square, the rail of five icons, the block and the field
// that open from his title-bar face, and the one panel that opens beside the rail. This is the rules of its geometry, of
// which panel shows and of the hover that previews one, pure, so they are tested without a window. The numbers are the
// approved mockup's (exploration #2027).
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

export type PanelId = "notifications" | "agents" | "sessions" | "downloads" | "keepawake";

// The usage detail is a panel too, opened by a click on the block under the square: it has no icon in the rail.
export type ShownPanel = PanelId | "usage";

export const RailPanels: PanelId[] = ["notifications", "agents", "sessions", "downloads", "keepawake"];

// A surface asks for a panel (a toast's Open, the downloads pill): seq tells two requests for the same panel apart, and
// highlight names the notifications to mark when the request is about some.
export type PanelRequest = { tab: PanelId; seq: number; highlight: string[] };

export const SquarePx = 264;
export const TilePx = 44;
// The rail is a tile wide plus this much (6 px on each side), and its icons start 6 px from its top.
export const RailPaddingPx = 12;
export const RailInsetPx = 6;
export const EdgePx = 8;
// From the rail to the panel; the ember link crosses it.
export const LinkPx = 16;
export const PanelWidthPx = 420;
export const MinPanelWidthPx = 280;
export const BlockHeightPx = 96;
export const FieldHeightPx = 36;

export type Rect = { x: number; y: number; w: number; h: number };

// Everything in the group's own coordinates: (0, 0) is the square's top left corner.
export type GroupGeometry = {
    square: number;
    tile: number;
    gap: number;
    railWidth: number;
    width: number;
    rail: Rect;
    icons: Record<PanelId, Rect>;
    block: Rect;
    field: Rect;
    // Where the panel starts.
    panelLeft: number;
};

// The gap between the icons is worked out so that the rail is exactly as tall as the square: (square - 12 - 5 tiles) / 4.
export function groupGeometry(square: number = SquarePx, tile: number = TilePx): GroupGeometry {
    const count = RailPanels.length;
    const gap = Math.max(0, (square - RailPaddingPx - count * tile) / (count - 1));
    const railWidth = tile + RailPaddingPx;
    const width = square + EdgePx + railWidth;
    const icons = {} as Record<PanelId, Rect>;
    RailPanels.forEach((id, i) => {
        icons[id] = { x: square + EdgePx + RailInsetPx, y: RailInsetPx + i * (tile + gap), w: tile, h: tile };
    });
    return {
        square,
        tile,
        gap,
        railWidth,
        width,
        rail: { x: square + EdgePx, y: 0, w: railWidth, h: square },
        icons,
        block: { x: 0, y: square + EdgePx, w: width, h: BlockHeightPx },
        field: { x: 0, y: square + EdgePx + BlockHeightPx + EdgePx, w: width, h: FieldHeightPx },
        panelLeft: width + LinkPx,
    };
}

// The panel is as tall as the square by default and grows past it only as far as its content needs, up to the window's
// room; past that it scrolls. It never fills the height for nothing.
export function panelHeight(contentHeight: number, room: number, square: number = SquarePx): number {
    return Math.max(0, Math.min(room, Math.max(square, contentHeight)));
}

// About 420 px, narrower only when the window is.
export function panelWidth(room: number): number {
    return Math.min(PanelWidthPx, Math.max(room, MinPanelWidthPx));
}

// The conversation window (FR-BOSS-009, AC22, #2033) grows from the field's top. It is this tall when the exchange is
// short and grows with it up to the most, or the window's room, then scrolls inside.
export const ConversationMinPx = 240;
export const ConversationMaxPx = 460;
// What the window adds to the exchange's own height: its padding (10 above, 4 below), the field's row (36 and its
// 1 px rule) and the frame's 2 px border (brokk-group.css).
export const ConversationChromePx = 53;

// As wide as the group and the panel area together: it reaches the right edge where a panel stands, and covers nothing
// since the panel gives way above it while it is open (panelRoom, #2090).
export function conversationWidth(g: GroupGeometry, panelRoom: number): number {
    return g.panelLeft + panelWidth(panelRoom);
}

// `contentHeight`: what the exchange needs, the field's row included. `room`: the window's height from the top of the
// field down.
export function conversationHeight(contentHeight: number, room: number): number {
    const most = Math.max(FieldHeightPx, Math.min(ConversationMaxPx, room));
    return Math.min(most, Math.max(ConversationMinPx, contentHeight));
}

export type GroupPlace = {
    // In the host layer's coordinates.
    left: number;
    top: number;
    // The width left to the right of the rail for the panel, and the height the window area offers.
    panelRoom: number;
    heightRoom: number;
};

// 8 px to the right of the sidebar and 8 px from the top of the window area; with no sidebar on screen, 8 px from the
// window's left edge. `inset` is the frame's margin around the window area inside the layer (--mt-frame-gap, 0 when
// there is no frame): the panels start that far into the layer, and a group placed at the layer's 8 px would sit on
// their corner, glued to the sidebar and the top (#2082). The gap is taken from whichever is further right, the
// sidebar's real edge (open, or the strip of a collapsed one) or the window area's.
export function groupPlace(
    sidebar: Rect,
    layer: { width: number; height: number },
    g: GroupGeometry,
    inset: number = 0
): GroupPlace {
    const edge = Math.max(sidebar != null ? sidebar.x + sidebar.w : 0, inset);
    const left = edge + EdgePx;
    const top = inset + EdgePx;
    return {
        left,
        top,
        panelRoom: layer.width - left - g.panelLeft - inset - EdgePx,
        heightRoom: layer.height - top - inset - EdgePx,
    };
}

// The offset from the middle of a rect to the middle of the title-bar face: everything of the group arrives from there.
export function arrivalOffset(origin: { x: number; y: number }, rect: Rect): { dx: number; dy: number } {
    return { dx: origin.x - (rect.x + rect.w / 2), dy: origin.y - (rect.y + rect.h / 2) };
}

// The rail and the block follow the square by 50 ms steps; the field comes first, it is the least to look at.
export const ArrivalStepMs = 50;

// The parts that move together (FR-BOSS-009: everything arrives together, from the title-bar face, #2082).
export type MotionPart = "square" | "rail" | "block" | "field" | "panel";
export const GroupParts: MotionPart[] = ["square", "rail", "block", "field"];

// The approved mockup's motion (exploration #2027). Each part's step of ArrivalStepMs on the way in (the --i of
// brokk-group.css): the rail and the block follow the square by one step; the panel shows with the square, never
// before it. On the way out nothing waits: everything goes back at once.
export const ArrivalSteps: Record<MotionPart, number> = { square: 0, rail: 1, block: 1, field: 0, panel: 0 };

// The durations of tokens.css, in ms: drop (the square's transform), snap (the rail's, the block's and the field's),
// show (their opacity), settle (the panel's slide), base (the panel's and its link's opacity) and fade (the only motion
// under reduced motion).
export type MotionDurations = { drop: number; snap: number; show: number; settle: number; base: number; fade: number };
export const GroupDurations: MotionDurations = { drop: 520, snap: 420, show: 200, settle: 260, base: 180, fade: 120 };

function transformMs(part: MotionPart, d: MotionDurations): number {
    if (part === "square") {
        return d.drop;
    }
    return part === "panel" ? d.settle : d.snap;
}

function opacityMs(part: MotionPart, d: MotionDurations): number {
    return part === "panel" ? d.base : d.show;
}

// When a part starts to show (or to leave) and when it is fully in place (or gone, its opacity at 0), in ms from the
// moment the group is asked to open (or to close). Under reduced motion every part takes the same short fade, with no
// step.
export function partMotion(
    part: MotionPart,
    way: "open" | "close",
    reduced: boolean,
    d: MotionDurations = GroupDurations
): { start: number; end: number } {
    if (reduced) {
        return { start: 0, end: d.fade };
    }
    if (way === "open") {
        const start = ArrivalSteps[part] * ArrivalStepMs;
        return { start, end: start + Math.max(transformMs(part, d), opacityMs(part, d)) };
    }
    return { start: 0, end: opacityMs(part, d) };
}

export function inRect(r: Rect, x: number, y: number): boolean {
    return r != null && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// The short ember link from an icon to the panel.
export function linkRect(g: GroupGeometry, id: PanelId): Rect {
    const icon = g.icons[id];
    return { x: icon.x + icon.w, y: icon.y, w: g.panelLeft - (icon.x + icon.w), h: icon.h };
}

// The hover zone of an icon: the icon, its link and the panel itself, so that the pointer can cross from one to the
// other without the panel folding.
export function inZone(g: GroupGeometry, id: PanelId, panel: Rect, x: number, y: number): boolean {
    return (
        inRect(g.icons[id], x, y) ||
        inRect(linkRect(g, id), x, y) ||
        (panel != null && panel.h > 0 && inRect(panel, x, y))
    );
}

export const HoverOpenMs = 80;
export const HoverCloseMs = 250;

export type HoverDeps = {
    geometry: () => GroupGeometry;
    // The open panel's rectangle, with no height when none shows.
    panel: () => Rect;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    onHover: (id: PanelId) => void;
};

// A pointer over an icon opens its panel after 80 ms; it folds 250 ms after the pointer left the zone. Crossing the gap
// between the icon and the panel, or from one icon to the next, never makes the panel flicker. The clock is the deps':
// the tests drive it by hand.
export class HoverIntent {
    deps: HoverDeps;
    hover: PanelId = null;
    private pending: PanelId = null;
    private openTimer: unknown = null;
    private closeTimer: unknown = null;
    private last = { x: -999, y: -999 };

    constructor(deps: HoverDeps) {
        this.deps = deps;
    }

    private clearOpen(): void {
        if (this.openTimer != null) {
            this.deps.clearTimer(this.openTimer);
        }
        this.openTimer = null;
        this.pending = null;
    }

    private clearClose(): void {
        if (this.closeTimer != null) {
            this.deps.clearTimer(this.closeTimer);
        }
        this.closeTimer = null;
    }

    private zoneOf(id: PanelId, x: number, y: number): boolean {
        return inZone(this.deps.geometry(), id, this.deps.panel(), x, y);
    }

    move(x: number, y: number): void {
        this.last = { x, y };
        if (this.hover != null && this.zoneOf(this.hover, x, y)) {
            this.clearClose();
            return;
        }
        const g = this.deps.geometry();
        const target = RailPanels.find((id) => inRect(g.icons[id], x, y)) ?? null;
        if (target != null) {
            this.clearClose();
            if (this.pending === target) {
                return;
            }
            this.clearOpen();
            this.pending = target;
            this.openTimer = this.deps.setTimer(() => this.opens(), HoverOpenMs);
            return;
        }
        this.clearOpen();
        if (this.hover != null && this.closeTimer == null) {
            this.closeTimer = this.deps.setTimer(() => this.closes(), HoverCloseMs);
        }
    }

    leave(): void {
        this.move(-999, -999);
    }

    // Forgets everything: the group closed.
    stop(): void {
        this.clearOpen();
        this.clearClose();
        this.hover = null;
    }

    private opens(): void {
        const target = this.pending;
        this.openTimer = null;
        this.pending = null;
        const g = this.deps.geometry();
        if (target == null || !inRect(g.icons[target], this.last.x, this.last.y) || this.hover === target) {
            return;
        }
        this.hover = target;
        this.deps.onHover(target);
    }

    private closes(): void {
        this.closeTimer = null;
        if (this.hover == null || this.zoneOf(this.hover, this.last.x, this.last.y)) {
            return;
        }
        this.hover = null;
        this.deps.onHover(null);
    }
}

// Which panel shows is a preview by hover first, then the one the developer pinned, then the one the group opened with.
export type PanelState = { pinned: ShownPanel; hover: PanelId };

export const InitialPanels: PanelState = { pinned: null, hover: null };

// A panel is always open while the group is (FR-BOSS-009, AC18, #2090): `auto` is the one the group opened with
// (groupOpeningPanel), so something always shows.
export function activePanel(state: PanelState, auto: ShownPanel): ShownPanel {
    return state.hover ?? state.pinned ?? auto;
}

// The panel the group opens on when the priority has nothing to say and the developer used none yet: the agents, the
// most useful one at rest.
export const DefaultPanel: PanelId = "agents";

// The panel the group opens with (#2090): the priority's when it has something to say, else the last one the developer
// used, else the agents. Never none.
export function groupOpeningPanel(facts: PriorityFacts, remembered: ShownPanel): ShownPanel {
    return openingPanel(facts) ?? remembered ?? DefaultPanel;
}

// The panel that takes the place of one the developer closed: the one the group opened with, else the agents, else the
// notifications, never the one closed. Closing the group is the way to have none.
export function fallbackPanel(closed: ShownPanel, auto: ShownPanel): ShownPanel {
    return [auto, DefaultPanel, "notifications" as ShownPanel].find((id) => id != null && id !== closed);
}

// The panel's close control: another panel shows, pinned.
export function afterClose(closed: ShownPanel, auto: ShownPanel): PanelState {
    return { pinned: fallbackPanel(closed, auto), hover: null };
}

// The windows never overlap (#2090): while the conversation window is open it grows from the field's top over the
// panel area, so the panel only has the room above it, 8 px clear; its content scrolls. It grows back when the window
// folds. `heightRoom` is the window area's room from the group's top.
export function panelRoom(g: GroupGeometry, heightRoom: number, conversation: boolean): number {
    if (!conversation) {
        return heightRoom;
    }
    return Math.max(0, Math.min(heightRoom, g.field.y - EdgePx));
}

// Brokk's report under the square is cut when its text needs more height than the card's two lines (#2090): only then
// does hovering or focusing it show the whole of it. 1 px of rounding is no cut.
export function reportCut(textHeight: number, shownHeight: number): boolean {
    return textHeight > shownHeight + 1;
}

// A web page tile is a guest view of its own: the window hears nothing from the pointer once it is over one, so a preview
// that the pointer left for a page would never fold. While a preview shows, a transparent sheet under the group catches
// the pointer everywhere, and the zone rule above folds it.
export function holdsHover(state: PanelState): boolean {
    return state.hover != null;
}

// A click on an icon pins its panel; a click on the icon of the one that shows keeps it, like a tab (#2090). The usage
// detail opens from a toggle under the square: a second click closes it, and another panel takes its place.
export function afterClick(state: PanelState, id: ShownPanel, active: ShownPanel, auto: ShownPanel): PanelState {
    if (id === "usage" && active === "usage") {
        return afterClose("usage", auto);
    }
    return { pinned: id, hover: null };
}

export function afterHover(state: PanelState, id: PanelId): PanelState {
    return { ...state, hover: id };
}

// A surface asked for a panel: it shows, pinned.
export function afterRequest(id: PanelId): PanelState {
    return { pinned: id, hover: null };
}

// What the priority rule reads.
export type PriorityFacts = {
    // A row is grave or waits for an answer.
    urgentOrAnswer: boolean;
    // An agent is blocked (waiting for the developer, or stopped on an error).
    agentBlocked: boolean;
    // A download failed or finished since the developer last looked at the Téléchargements panel.
    downloadReported: boolean;
    // Another notification is unread.
    unread: boolean;
    downloadRunning: boolean;
};

// The panel that opens when the group opens (FR-BOSS-009, AC18), null when there is nothing to say.
export function openingPanel(facts: PriorityFacts): PanelId {
    if (facts.urgentOrAnswer) {
        return "notifications";
    }
    if (facts.agentBlocked) {
        return "agents";
    }
    if (facts.downloadReported) {
        return "downloads";
    }
    if (facts.unread) {
        return "notifications";
    }
    if (facts.downloadRunning) {
        return "downloads";
    }
    return null;
}

// Up and Down (the rail is vertical), Home and End move between the icons and wrap.
export function neighbourPanel(current: PanelId, key: string): PanelId {
    const at = RailPanels.indexOf(current);
    if (key === "Home") {
        return RailPanels[0];
    }
    if (key === "End") {
        return RailPanels[RailPanels.length - 1];
    }
    if (key !== "ArrowDown" && key !== "ArrowUp") {
        return null;
    }
    return RailPanels[(Math.max(at, 0) + (key === "ArrowDown" ? 1 : RailPanels.length - 1)) % RailPanels.length];
}

export type RailMark = {
    // The count shown on the icon, 0 for none.
    count: number;
    // Red: something is grave or waits for an answer.
    grave: boolean;
    // A dot: something asks to be looked at without a number.
    dot: boolean;
    // A progress ring around the icon: 0 to 1, -1 when the size is unknown, null for none.
    ring: number;
    // The ember dot of keep-awake.
    ember: boolean;
};

// What the group reads when it opens and while it stays open: the rail's marks and the priority come from the same facts.
export type RailInput = {
    // What the face's badge counts, by key (useAvatarKeys): the rail shares them out between its icons, so that the
    // badge is always the sum of the rail's counts (#2085).
    badgeKeys: string[];
    urgentOrAnswer: boolean;
    // A row of the Notifications panel is unread, whatever its priority (a ready pull request is Fait and still news).
    unread: boolean;
    agentBlocked: boolean;
    downloadReported: boolean;
    // The mean progress of the running downloads, null when none runs, and whether one does.
    downloadProgress: number;
    downloadRunning: boolean;
    keepAwake: boolean;
};

// must match the key downloadEventsOf gives in brokk-extra-feeds.ts
const DownloadBadgePrefix = "download:";

// Where each item of the badge is told: a download that finished or failed in Téléchargements, everything else (the rows
// To handle, the agents that finished, the update, the plan usage) in Notifications. A running download is no item of
// the badge: it shows as the ring.
export function badgeShares(keys: string[]): { notifications: number; downloads: number } {
    const downloads = (keys ?? []).filter((key) => key.startsWith(DownloadBadgePrefix)).length;
    return { notifications: (keys ?? []).length - downloads, downloads };
}

// The facts of the opening priority: an item of the badge is news for its own icon even when the panel's own facts
// missed it.
export function priorityFactsOf(input: RailInput): PriorityFacts {
    const shares = badgeShares(input.badgeKeys);
    return {
        urgentOrAnswer: input.urgentOrAnswer,
        agentBlocked: input.agentBlocked,
        downloadReported: input.downloadReported || shares.downloads > 0,
        unread: input.unread || shares.notifications > 0,
        downloadRunning: input.downloadRunning,
    };
}

const NoMark: RailMark = { count: 0, grave: false, dot: false, ring: null, ember: false };

// What each closed icon shows (FR-BOSS-009, AC17): a count, a dot, a progress ring, the cup's ember. The counts are the
// badge's items, shared out; what is news without being one of them is a dot.
export function railMarks(input: RailInput): Record<PanelId, RailMark> {
    const shares = badgeShares(input.badgeKeys);
    return {
        notifications: {
            ...NoMark,
            count: shares.notifications,
            grave: input.urgentOrAnswer,
            dot: shares.notifications === 0 && input.unread,
        },
        agents: { ...NoMark, dot: input.agentBlocked },
        sessions: NoMark,
        downloads: {
            ...NoMark,
            count: shares.downloads,
            dot: shares.downloads === 0 && input.downloadReported && !input.downloadRunning,
            ring: input.downloadRunning ? (input.downloadProgress ?? -1) : null,
        },
        keepawake: { ...NoMark, ember: input.keepAwake },
    };
}

export function railCountTotal(marks: Record<PanelId, RailMark>): number {
    return RailPanels.reduce((sum, id) => sum + marks[id].count, 0);
}
