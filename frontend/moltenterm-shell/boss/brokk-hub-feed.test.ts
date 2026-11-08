// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { ToHandleItem } from "./boss-to-handle-model";
import { avatarBadgeOf, finishedSetAfter, unmappedRowCount } from "./brokk-hub-feed";
import { DefaultVisitSettings, VisitSettings } from "./brokk-visit-events";

function item(key: string, tone: ToHandleItem["tone"] = "waiting", extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone,
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: key },
        place: "",
        since: 0,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    };
}

function agent(blockid: string, state: AgentStateInfo["state"]): AgentStateInfo {
    return { blockid, agent: "claude", firstname: blockid, state, version: 1, since: 1 };
}

function states(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((info) => [info.blockid, info])), versions: {} };
}

function settings(coming: Partial<VisitSettings["coming"]>): VisitSettings {
    return { ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, ...coming } };
}

describe("the agents that finished (FR-BOSS-009, AC1)", () => {
    it("adds an agent that went from working to done", () => {
        const set = finishedSetAfter([], states(agent("a", "working")), states(agent("a", "done")), 42);
        expect(set).toEqual([{ key: "finished:a", kind: "finished", since: 42 }]);
    });

    it("keeps it while the agent stays done, as the very same set", () => {
        const first = finishedSetAfter([], states(agent("a", "working")), states(agent("a", "done")), 42);
        const again = finishedSetAfter(first, states(agent("a", "done")), states(agent("a", "done"), agent("b", "idle")), 50);
        expect(again).toBe(first);
    });

    it("drops it when the agent works again, waits, fails, or its session ends", () => {
        const first = finishedSetAfter([], states(agent("a", "working")), states(agent("a", "done")), 42);
        for (const next of [states(agent("a", "working")), states(agent("a", "waiting")), states(agent("a", "error")), states()]) {
            expect(finishedSetAfter(first, states(agent("a", "done")), next, 60)).toEqual([]);
        }
    });

    it("does not add an agent that was already done at the first reading", () => {
        expect(finishedSetAfter([], null, states(agent("a", "done")), 42)).toEqual([]);
    });

    it("adds a second agent next to the first", () => {
        const first = finishedSetAfter([], states(agent("a", "working")), states(agent("a", "done")), 42);
        const both = finishedSetAfter(
            first,
            states(agent("a", "done"), agent("b", "working")),
            states(agent("a", "done"), agent("b", "done")),
            50
        );
        expect(both.map((event) => event.key)).toEqual(["finished:a", "finished:b"]);
    });
});

describe("the avatar's badge (FR-BOSS-009, AC1)", () => {
    it("counts what the model counts, and the rows that are no event as the bubble did", () => {
        const rows = [item("agent:a"), item("handoff:x"), item("question:y")];
        expect(unmappedRowCount(rows)).toBe(2);
        const badge = avatarBadgeOf(rows, 1, DefaultVisitSettings);
        expect(badge).toEqual({ count: 3, text: "3", tone: "waiting" });
    });

    it("does not count a row the developer has seen", () => {
        expect(unmappedRowCount([item("handoff:x", "waiting", { seen: true })])).toBe(0);
    });

    it("is red when a counted row is a failure, amber otherwise", () => {
        expect(avatarBadgeOf([item("agent:a", "error")], 1, DefaultVisitSettings).tone).toBe("error");
        expect(avatarBadgeOf([item("agent:a", "waiting")], 1, DefaultVisitSettings).tone).toBe("waiting");
        expect(avatarBadgeOf([item("question:y", "error")], 0, DefaultVisitSettings).tone).toBe("error");
    });

    it("is not red for a failure the developer set to Rien", () => {
        const badge = avatarBadgeOf([item("agent:a", "error")], 0, settings({ error: "rien" }));
        expect(badge.tone).toBe("waiting");
        expect(badge.count).toBe(0);
    });

    it("reads 9+ beyond nine", () => {
        expect(avatarBadgeOf([], 9, DefaultVisitSettings).text).toBe("9");
        expect(avatarBadgeOf([], 10, DefaultVisitSettings).text).toBe("9+");
    });
});
