// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HandoffHistoryEntry } from "../agent-links/agent-links-model";
import {
    linkedAgents,
    mcpServerRows,
    parentTurnStart,
    sharedPages,
    startedAgo,
    subagentDuration,
    subagentGroups,
    subagentKindKey,
    subagentRows,
    type SubagentRow,
} from "./agent-info-model";

const names: Record<string, string> = { a: "Valentin", b: "Olivia", c: "Victoire" };
const nameOf = (id: string) => names[id] ?? "";

describe("linkedAgents", () => {
    it("lists handoffs in and out, one row per agent and direction, the latest goal first", () => {
        const history: HandoffHistoryEntry[] = [
            { fromblockid: "a", toblockid: "b", goal: "publish #1114", at: 1 },
            { fromblockid: "a", toblockid: "b", goal: "publish again", at: 5 },
            { fromblockid: "c", toblockid: "a", goal: "review", at: 3 },
            { fromblockid: "b", toblockid: "c", goal: "not mine", at: 9 },
        ];
        const rows = linkedAgents("a", history, {}, nameOf);
        expect(rows).toEqual([
            { blockId: "b", dir: "out", name: "Olivia", goal: "publish again", at: 5, count: 2 },
            { blockId: "c", dir: "in", name: "Victoire", goal: "review", at: 3, count: 1 },
        ]);
    });

    it("names an ended agent by the name the handoff recorded", () => {
        const rows = linkedAgents("a", [{ fromblockid: "a", toblockid: "gone", to: "Lucas", at: 1 }], {}, nameOf);
        expect(rows[0].name).toBe("Lucas");
    });

    it("keeps the persisted first parent and children after a restart", () => {
        const rows = linkedAgents("a", [], { a: "c", b: "a" }, nameOf);
        expect(rows.map((r) => `${r.dir}:${r.blockId}`).sort()).toEqual(["in:c", "out:b"]);
        expect(linkedAgents("a", [{ fromblockid: "c", toblockid: "a", at: 2 }], { a: "c" }, nameOf)).toHaveLength(1);
        expect(linkedAgents("", [], { a: "c" }, nameOf)).toEqual([]);
    });
});

describe("subagentRows", () => {
    it("reads the companion's sub-agents, running first, with kind and model", () => {
        const rows = subagentRows({
            blockid: "a",
            version: 1,
            status: "ok" as any,
            subagents: [
                { id: "1", description: "Screen inventory", kind: "Explore", model: "Haiku 5.5", state: "done" },
                { id: "2", description: "Code review", kind: "general-purpose", model: "Opus 5.5", state: "running" },
                { id: "3", kind: "worker", state: "failed" },
                { id: "4", state: "running" },
            ],
        });
        const plain = { effort: "", branch: "", started: 0, ended: 0 };
        expect(rows).toEqual([
            { id: "2", name: "Code review", kind: "general-purpose", model: "Opus 5.5", state: "working", ...plain },
            { id: "3", name: "worker", kind: "worker", model: "", state: "error", ...plain },
            { id: "1", name: "Screen inventory", kind: "Explore", model: "Haiku 5.5", state: "done", ...plain },
        ]);
        expect(subagentRows(null)).toEqual([]);
    });
});

describe("subagentGroups", () => {
    const row = (id: string, state: SubagentRow["state"], started: number, ended = 0): SubagentRow => ({
        id,
        name: `Ticket #${id}`,
        kind: "general-purpose",
        model: "",
        state,
        started,
        ended,
    });
    // The audit's case (#1316 F8): 3 running, 9 finished before the parent's latest prompt.
    const twelve = [
        ...Array.from({ length: 9 }, (_, i) => row(`d${i}`, "done", 10 + i, 20 + i)),
        row("r1", "working", 50),
        row("r2", "working", 51),
        row("r3", "idle", 52),
    ];

    it("shows the running ones and folds the ones finished before the parent's turn", () => {
        const g = subagentGroups(twelve, 40, false, {});
        expect(g.running.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
        expect(g.recent).toEqual([]);
        expect(g.folded).toHaveLength(9);
        expect(g.folded[0].id).toBe("d8");
        expect(g.working).toBe(2);
    });

    it("keeps the ones finished during the parent's turn as rows until its next one", () => {
        const g = subagentGroups([...twelve, row("late", "done", 55, 60)], 40, false, {});
        expect(g.recent.map((r) => r.id)).toEqual(["late"]);
        expect(subagentGroups([...twelve, row("late", "done", 55, 60)], 70, false, {}).recent).toEqual([]);
        expect(subagentGroups(twelve, 0, false, {}).folded).toHaveLength(9);
    });

    it("clears the finished ones once the parent stops, or by hand", () => {
        expect(subagentGroups(twelve, 40, true, {}).folded).toEqual([]);
        expect(subagentGroups(twelve, 40, true, {}).running).toHaveLength(3);
        const g = subagentGroups(twelve, 40, false, { d0: true, d1: true, r1: true });
        expect(g.folded).toHaveLength(7);
        expect(g.running).toHaveLength(3);
    });

    it("reads the parent's turn from its last prompt, even one that used no tool yet", () => {
        const topics = [{ text: "a", at: 5 }];
        expect(
            parentTurnStart({
                blockid: "a",
                version: 1,
                status: "ok" as any,
                topics,
                session: { lastprompt: 12 } as any,
            })
        ).toBe(12);
    });

    it("reads the parent's turn from its latest topic", () => {
        expect(
            parentTurnStart({
                blockid: "a",
                version: 1,
                status: "ok" as any,
                topics: [
                    { text: "a", at: 5 },
                    { text: "b", at: 9 },
                ],
            })
        ).toBe(9);
        expect(parentTurnStart(null)).toBe(0);
    });
});

describe("subagentKindKey", () => {
    it("translates the types the agents name, and leaves a user's own type as it is", () => {
        expect(subagentKindKey("general-purpose")).toBe("agentInfo.subKind.general");
        expect(subagentKindKey("Explore")).toBe("agentInfo.subKind.explore");
        expect(subagentKindKey("explorer")).toBe("agentInfo.subKind.explore");
        expect(subagentKindKey("my-reviewer")).toBe("");
        expect(subagentKindKey(undefined)).toBe("");
    });
});

describe("subagentDuration", () => {
    it("says how long it ran, or runs so far", () => {
        expect(subagentDuration(1000, 46_000, 0, "en")).toBe("45 sec");
        expect(subagentDuration(0, 46_000, 0, "en")).toBe("");
        expect(subagentDuration(1, 4 * 60_000 + 1, 0, "fr").replace(/\s/g, " ")).toBe("4 min");
        expect(subagentDuration(1, 0, 80 * 60_000 + 1, "en")).toBe("1 hr 20 min");
    });
});

describe("mcpServerRows", () => {
    it("lists each MoltenTerm server once with its state", () => {
        const rows = mcpServerRows({
            blockid: "a",
            version: "1",
            agents: [
                {
                    links: [
                        { key: "1", server: "molten-review", state: "broken" },
                        { key: "2", server: "molten-browser", state: "connected" },
                    ],
                },
                { links: [{ key: "3", server: "molten-browser", state: "stopped" }] },
            ],
        });
        expect(rows).toEqual([
            { server: "molten-browser", state: "connected", live: true },
            { server: "molten-review", state: "broken", live: false },
        ]);
        expect(mcpServerRows(null)).toEqual([]);
    });
});

describe("sharedPages", () => {
    it("finds the tabs the agent holds by its terminal, not by name", () => {
        const pages = sharedPages(
            "panel",
            "tab",
            "a",
            [
                { browsertabid: "x", agentname: "Valentin", agentblockid: "a", origin: "shared", state: "active" },
                { browsertabid: "y", agentname: "Valentin", agentblockid: "other", origin: "agent", state: "active" },
                { browsertabid: "z", agentname: "Valentin", agentblockid: "a", origin: "agent", state: "active" },
            ],
            [
                { id: "x", url: "https://example.com/spec", title: "The spec" },
                { id: "y", url: "https://example.com/other" },
                { id: "z", url: "https://example.com/z" },
            ]
        );
        expect(pages.map((p) => [p.browserTabId, p.title, p.shared])).toEqual([
            ["x", "The spec", true],
            ["z", "https://example.com/z", false],
        ]);
    });
});

describe("startedAgo", () => {
    it("words minutes, hours, then days", () => {
        const now = 10 * 24 * 3600_000;
        expect(startedAgo(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
        expect(startedAgo(now - 130 * 60_000, now, "en")).toBe("2 hours ago");
        expect(startedAgo(now - 3 * 24 * 3600_000, now, "en")).toBe("3 days ago");
        expect(startedAgo(0, now, "en")).toBe("");
    });
});
