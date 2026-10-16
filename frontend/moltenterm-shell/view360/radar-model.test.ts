// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import type { MoltentermNotification } from "../notifications-model";
import {
    attentionByBlock,
    buildRadarTicks,
    RadarBlockFacts,
    RadarColumnInput,
    radarHint,
    radarKind,
    RadarKindColors,
    radarPitchPx,
    RadarText,
    radarToContentX,
    stepCarpetColumn,
} from "./radar-model";

function col(columnId: string, ...blockIds: string[]): RadarColumnInput {
    return { columnId, leaves: blockIds.map((b) => ({ nodeId: `n-${b}`, blockId: b })) };
}

const facts: Record<string, RadarBlockFacts> = {
    a: { view: "term", agent: true, title: "Léa · Claude Code", attention: null },
    w: { view: "molten-browser", agent: false, title: "github.com", attention: null },
    c: { view: "molten-companion", agent: false, title: "Companion", attention: null },
    r: { view: "molten-review", agent: false, title: "Review", attention: null },
    t: { view: "term", agent: false, title: "~", attention: "notification" },
    q: { view: "term", agent: true, title: "Codex", attention: "answer" },
};

function notif(over: Partial<MoltentermNotification>): MoltentermNotification {
    return { id: "x", time: 1, updated: 1, kind: "info", read: false, source: "agent", title: "t", ...over };
}

describe("radar kinds", () => {
    it("colours a tick by its panel kind, an agent's terminal as an agent", () => {
        expect(radarKind("term", true)).toBe("agent");
        expect(radarKind("term", false)).toBe("term");
        expect(radarKind("web", false)).toBe("web");
        expect(radarKind("molten-browser", false)).toBe("web");
        expect(radarKind("molten-companion", false)).toBe("companion");
        expect(radarKind("molten-review-ai", false)).toBe("review");
        expect(radarKind("molten-project", false)).toBe("project");
        expect(radarKind("preview", false)).toBe("files");
        expect(radarKind("sysinfo", false)).toBe("other");
        expect(radarKind(null, false)).toBe("other");
    });

    it("gives every kind its own colour", () => {
        const colors = Object.values(RadarKindColors);
        expect(new Set(colors).size).toBe(colors.length);
    });
});

describe("buildRadarTicks", () => {
    it("has one tick per carpet column, in carpet order, coloured by kind", () => {
        const ticks = buildRadarTicks([col("c1", "c"), col("c2", "w"), col("c3", "r")], facts, ["c2"]);
        expect(ticks.map((t) => t.columnId)).toEqual(["c1", "c2", "c3"]);
        expect(ticks.map((t) => t.kind)).toEqual(["companion", "web", "review"]);
        expect(ticks.map((t) => t.color)).toEqual([
            RadarKindColors.companion,
            RadarKindColors.web,
            RadarKindColors.review,
        ]);
    });

    it("marks the visible range and the side of the others", () => {
        const ticks = buildRadarTicks([col("c1", "c"), col("c2", "w"), col("c3", "r"), col("c4", "a")], facts, [
            "c2",
            "c3",
        ]);
        expect(ticks.map((t) => t.visible)).toEqual([false, true, true, false]);
        expect(ticks.map((t) => t.side)).toEqual(["left", null, null, "right"]);
    });

    it("takes a split column's kind and title from its first panel and its attention from any panel", () => {
        const [tick] = buildRadarTicks([col("c1", "w", "q", "t")], facts, ["c1"]);
        expect(tick.kind).toBe("web");
        expect(tick.title).toBe(`github.com ${RadarText.morePanels(2)}`);
        expect(tick.attention).toBe("answer");
        expect(tick.focusNodeId).toBe("n-q");
    });

    it("focuses the column's first panel when nothing waits, and names an unknown panel", () => {
        const [tick] = buildRadarTicks([col("c1", "zz")], facts, []);
        expect(tick.focusNodeId).toBe("n-zz");
        expect(tick.title).toBe(RadarText.untitled);
        expect(tick.attention).toBeNull();
        expect(tick.side).toBe("left");
    });
});

describe("radarHint", () => {
    it("says where the panel is and that a click goes there", () => {
        const ticks = buildRadarTicks([col("c1", "c"), col("c2", "w")], facts, ["c1"]);
        expect(radarHint(ticks[0])).toBe("in view");
        expect(radarHint(ticks[1])).toBe("off-screen to the right · click to go there");
    });

    it("leads with what the panel waits for", () => {
        const ticks = buildRadarTicks([col("c1", "q"), col("c2", "t")], facts, ["c2"]);
        expect(radarHint(ticks[0])).toBe("waiting for your answer · off-screen to the left");
        expect(radarHint(ticks[1])).toBe("a notification is waiting · in view");
    });
});

describe("attentionByBlock", () => {
    const states: Record<string, AgentStateInfo> = {
        b1: { blockid: "b1", state: "waiting", version: 1 },
        b2: { blockid: "b2", state: "working", version: 1 },
    };

    it("flags an agent waiting for an answer, not one working", () => {
        expect(attentionByBlock(states, [])).toEqual({ b1: "answer" });
    });

    it("flags an open notification on a block, until it is read, resolved or archived", () => {
        expect(attentionByBlock({}, [notif({ blockid: "b3" })])).toEqual({ b3: "notification" });
        expect(attentionByBlock({}, [notif({ blockid: "b3", read: true })])).toEqual({});
        expect(attentionByBlock({}, [notif({ blockid: "b3", resolved: 2 })])).toEqual({});
        expect(attentionByBlock({}, [notif({ blockid: "b3", archived: 2 })])).toEqual({});
        expect(attentionByBlock({}, [notif({})])).toEqual({});
    });

    it("reads a handoff waiting for approval as waiting for an answer, until it is answered", () => {
        const approval = notif({
            key: "agenthandoff:r1",
            source: "agents" as MoltentermNotification["source"],
            kind: "warning",
            read: true,
            blockid: "b4",
            actions: [{ id: "once", label: "Allow once", kind: "gesture", gesture: "molten:agenthandoff" }],
        });
        expect(attentionByBlock({}, [approval])).toEqual({ b4: "answer" });
        expect(attentionByBlock({}, [{ ...approval, resolved: 3 }])).toEqual({});
    });
});

describe("stepCarpetColumn", () => {
    const ids = ["c1", "c2", "c3"];

    it("moves one column at a time and stays at the ends", () => {
        expect(stepCarpetColumn(ids, "c2", 1)).toBe("c3");
        expect(stepCarpetColumn(ids, "c2", -1)).toBe("c1");
        expect(stepCarpetColumn(ids, "c3", 1)).toBeNull();
        expect(stepCarpetColumn(ids, "c1", -1)).toBeNull();
    });

    it("goes from the fixed zone to the first column in view", () => {
        expect(stepCarpetColumn(ids, null, 1, ["c2", "c3"])).toBe("c2");
        expect(stepCarpetColumn(ids, null, 1)).toBe("c1");
        expect(stepCarpetColumn(ids, null, -1, ["c2"])).toBeNull();
        expect(stepCarpetColumn([], null, 1)).toBeNull();
    });
});

describe("radarToContentX", () => {
    const ticks = [10, 21, 32];
    const centers = [300, 900, 1400];

    it("maps tick centres to column centres and interpolates between them", () => {
        expect(radarToContentX(10, ticks, centers)).toBe(300);
        expect(radarToContentX(21, ticks, centers)).toBe(900);
        expect(radarToContentX(15.5, ticks, centers)).toBe(600);
        expect(radarToContentX(26.5, ticks, centers)).toBe(1150);
    });

    it("extends the end segments past the ends", () => {
        expect(radarToContentX(-1, ticks, centers)).toBe(-300);
        expect(radarToContentX(43, ticks, centers)).toBe(1900);
    });

    it("uses the fallback slope with a single tick", () => {
        expect(radarToContentX(15, [10], [300], 40)).toBe(500);
        expect(radarToContentX(15, [], [])).toBe(0);
    });
});

describe("radarPitchPx", () => {
    it("keeps the 9 px gap while there is room, then tightens down to 3 px", () => {
        expect(radarPitchPx(5, 400)).toBe(11);
        expect(radarPitchPx(50, 400)).toBe(8);
        expect(radarPitchPx(500, 400)).toBe(5);
        expect(radarPitchPx(1, 0)).toBe(11);
    });
});
