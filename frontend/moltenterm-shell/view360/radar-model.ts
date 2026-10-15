// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The radar scrubber of the carpet (FR-SHELL-068, DS-SHELL-119): one tick per carpet column, in carpet order, coloured
// by its panel kind; the ticks of the columns in view are framed by a window (#678); the tick of a column that needs
// attention pulses. Kept apart from the component so the rules are tested without the app.

import type { AgentStateInfo } from "../agent-state-model";
import { MoltentermBrowserView } from "../browser/browser-model";
import { MoltentermCompanionView } from "../companion/companion-model";
import { t } from "../i18n/i18n";
import { MoltentermLineMapView } from "../mission/line-map-model";
import { checkOpen, type MoltentermNotification } from "../notifications-model";
import { LegacyTimelineView, MoltentermProjectView } from "../project/project-model";
import { MoltentermReviewAiView, MoltentermReviewView } from "../review/review-model";
import { MoltentermReviewsView } from "../reviews/reviews-model";
import { MoltentermSessionsView } from "../sessions/sessions-model";

// The CI/CD view's type, repeated here so this file stays free of the view's React code.
const CicdView = "molten-cicd";

export type RadarKind = "agent" | "term" | "web" | "companion" | "review" | "project" | "files" | "other";

// One colour per kind, bright enough on the carpet's dark ground; the agent's is the molten accent.
export const RadarKindColors: Record<RadarKind, string> = {
    agent: "#ea580c",
    term: "#a8a29e",
    web: "#38bdf8",
    companion: "#a78bfa",
    review: "#4ade80",
    project: "#facc15",
    files: "#2dd4bf",
    other: "#78716c",
};

const ViewKinds: Record<string, RadarKind> = {
    term: "term",
    web: "web",
    [MoltentermBrowserView]: "web",
    [MoltentermCompanionView]: "companion",
    [MoltentermReviewView]: "review",
    [MoltentermReviewAiView]: "review",
    [MoltentermReviewsView]: "review",
    [MoltentermProjectView]: "project",
    [LegacyTimelineView]: "project",
    [MoltentermSessionsView]: "project",
    [MoltentermLineMapView]: "project",
    [CicdView]: "project",
    preview: "files",
    codeeditor: "files",
};

// "answer": an agent waits for the developer (its state, or a handoff waiting for approval); "notification": an open
// notification of the notification center points at the panel.
export type RadarAttention = "answer" | "notification";

// The UI text of the radar, read through the interface's keys at each access (FR-I18N-001). Never names the machine
// or the system (#628).
export const RadarText = {
    get label() {
        return t("view360.radar.label");
    },
    get inView() {
        return t("view360.radar.inView");
    },
    get offLeft() {
        return t("view360.radar.offLeft");
    },
    get offRight() {
        return t("view360.radar.offRight");
    },
    get clickToGo() {
        return t("view360.radar.clickToGo");
    },
    get answer() {
        return t("view360.radar.answer");
    },
    get notification() {
        return t("view360.radar.notification");
    },
    get untitled() {
        return t("view360.radar.untitled");
    },
    get window() {
        return t("view360.radar.window");
    },
    get windowHint() {
        return t("view360.radar.windowHint");
    },
    morePanels: (n: number) =>
        n === 1 ? t("view360.radar.morePanelsOne") : t("view360.radar.morePanels", { count: n }),
};

// What the radar needs to know of one block.
export type RadarBlockFacts = {
    view: string;
    // A coding agent runs in the terminal.
    agent: boolean;
    title: string;
    attention: RadarAttention;
};

export type RadarColumnInput = {
    columnId: string;
    // The column's panels, top to bottom; the first one gives the column its kind and title.
    leaves: { nodeId: string; blockId: string }[];
};

export type RadarTick = {
    columnId: string;
    // The panel a click or a shortcut focuses: the one needing attention, else the column's first.
    focusNodeId: string;
    kind: RadarKind;
    color: string;
    title: string;
    visible: boolean;
    // Where an off-screen column lies, null for one in view.
    side: "left" | "right";
    attention: RadarAttention;
};

// The handoff approval's gesture (agent-handoff.ts; must match pkg/molten/handoffwire/handoffwire.go), repeated so this
// file stays free of the RPC client.
const HandoffGesture = "molten:agenthandoff";

function isHandoffApproval(entry: MoltentermNotification): boolean {
    return (entry.actions ?? []).some((a) => a.kind === "gesture" && a.gesture === HandoffGesture);
}

// What each block waits for, from the signals the app already has: an agent waiting for an answer (FR-SHELL-011), a
// handoff waiting for approval (FR-CONT-015, raised on the asking agent's block), an open notification on the block
// (FR-SHELL-002; the shown ones, so a subject turned off never pulses).
export function attentionByBlock(
    agentStates: Record<string, AgentStateInfo>,
    notifications: MoltentermNotification[]
): Record<string, RadarAttention> {
    const rtn: Record<string, RadarAttention> = {};
    for (const entry of notifications ?? []) {
        if (!entry?.blockid || !checkOpen(entry)) {
            continue;
        }
        const a: RadarAttention = isHandoffApproval(entry) ? "answer" : "notification";
        if (moreUrgent(a, rtn[entry.blockid] ?? null)) {
            rtn[entry.blockid] = a;
        }
    }
    for (const info of Object.values(agentStates ?? {})) {
        if (info?.blockid && info.state === "waiting") {
            rtn[info.blockid] = "answer";
        }
    }
    return rtn;
}

export function radarKind(view: string, agent: boolean): RadarKind {
    if (agent) {
        return "agent";
    }
    return ViewKinds[view ?? ""] ?? "other";
}

const AttentionRank: Record<RadarAttention, number> = { answer: 2, notification: 1 };

function moreUrgent(a: RadarAttention, b: RadarAttention): boolean {
    return (AttentionRank[a] ?? 0) > (AttentionRank[b] ?? 0);
}

export function buildRadarTicks(
    columns: RadarColumnInput[],
    facts: Record<string, RadarBlockFacts>,
    visibleIds: string[]
): RadarTick[] {
    const visible = new Set(visibleIds ?? []);
    const order = (columns ?? []).map((c) => c.columnId);
    const firstVisible = order.findIndex((id) => visible.has(id));
    return (columns ?? []).map((column, i) => {
        const lead = column.leaves[0];
        const leadFacts = lead == null ? null : facts?.[lead.blockId];
        let attention: RadarAttention = null;
        let focusNodeId = lead?.nodeId ?? column.columnId;
        for (const leaf of column.leaves) {
            const a = facts?.[leaf.blockId]?.attention ?? null;
            if (a != null && moreUrgent(a, attention)) {
                attention = a;
                focusNodeId = leaf.nodeId;
            }
        }
        const kind = radarKind(leadFacts?.view, !!leadFacts?.agent);
        const more = column.leaves.length - 1;
        const baseTitle = leadFacts?.title || RadarText.untitled;
        const isVisible = visible.has(column.columnId);
        return {
            columnId: column.columnId,
            focusNodeId,
            kind,
            color: RadarKindColors[kind],
            title: more > 0 ? `${baseTitle} ${RadarText.morePanels(more)}` : baseTitle,
            visible: isVisible,
            side: isVisible ? null : firstVisible === -1 || i < firstVisible ? "left" : "right",
            attention,
        };
    });
}

// The second line of the hover card: what the panel waits for, where it is, and what a click does.
export function radarHint(tick: RadarTick): string {
    const parts: string[] = [];
    if (tick.attention != null) {
        parts.push(RadarText[tick.attention]);
    }
    if (tick.visible) {
        parts.push(RadarText.inView);
        return parts.join(" · ");
    }
    parts.push(tick.side === "left" ? RadarText.offLeft : RadarText.offRight);
    if (tick.attention == null) {
        parts.push(RadarText.clickToGo);
    }
    return parts.join(" · ");
}

// The hover card's line for the window (#678): what it is and what it does, in one line under a panel's title.
export function radarWindowLine(): string {
    return `${RadarText.window} — ${RadarText.windowHint}`;
}

// The column the previous / next shortcut goes to. From the fixed zone (current null) next goes to the first column
// in view, previous to none; at either end of the carpet it stays.
export function stepCarpetColumn(
    columnIds: string[],
    currentColumnId: string,
    dir: -1 | 1,
    visibleIds: string[] = []
): string {
    if (!columnIds?.length) {
        return null;
    }
    const at = currentColumnId == null ? -1 : columnIds.indexOf(currentColumnId);
    if (at === -1) {
        if (dir < 0) {
            return null;
        }
        return columnIds.find((id) => visibleIds?.includes(id)) ?? columnIds[0];
    }
    const next = at + dir;
    if (next < 0 || next >= columnIds.length) {
        return null;
    }
    return columnIds[next];
}

// Where the carpet's content is under a point of the radar while the pill is dragged: tick centres map to column
// centres, linearly in between, and past the ends with the slope of the nearest segment (or one tick per column
// width when there is a single tick).
export function radarToContentX(x: number, tickCenters: number[], columnCenters: number[], fallbackSlope = 1): number {
    const n = Math.min(tickCenters?.length ?? 0, columnCenters?.length ?? 0);
    if (n === 0 || !Number.isFinite(x)) {
        return 0;
    }
    if (n === 1) {
        return columnCenters[0] + (x - tickCenters[0]) * fallbackSlope;
    }
    let i = 0;
    if (x >= tickCenters[n - 1]) {
        i = n - 2;
    } else {
        while (i < n - 2 && x > tickCenters[i + 1]) {
            i++;
        }
    }
    const t0 = tickCenters[i];
    const t1 = tickCenters[i + 1];
    const span = t1 - t0;
    const slope = span > 0 ? (columnCenters[i + 1] - columnCenters[i]) / span : fallbackSlope;
    return columnCenters[i] + (x - t0) * slope;
}

// Ticks keep their 9 px gap until the radar runs out of room, then come closer (never under 3 px).
export const RadarTickPx = 2;
export const RadarGapPx = 9;
export const RadarMinGapPx = 3;

export function radarPitchPx(count: number, availPx: number): number {
    const full = RadarTickPx + RadarGapPx;
    if (count <= 1 || !(availPx > 0) || count * full <= availPx) {
        return full;
    }
    return Math.max(RadarTickPx + RadarMinGapPx, Math.floor(availPx / count));
}
