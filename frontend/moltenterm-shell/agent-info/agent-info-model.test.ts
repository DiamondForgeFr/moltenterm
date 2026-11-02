// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HandoffHistoryEntry } from "../agent-links/agent-links-model";
import {
    linkedAgents,
    mcpServerRows,
    nextSubagentExpiry,
    sharedPages,
    startedAgo,
    subagentCardGroups,
    subagentDayLabel,
    subagentDays,
    subagentDuration,
    subagentGroups,
    subagentKindKey,
    SubagentLingerMs,
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
    const Now = Date.UTC(2026, 9, 30, 12, 0, 0);
    const Minute = 60_000;
    const row = (id: string, state: SubagentRow["state"], started: number, ended = 0): SubagentRow => ({
        id,
        name: `Ticket #${id}`,
        kind: "general-purpose",
        model: "",
        state,
        started,
        ended,
    });
    // The audit's case (#1316 F8): 3 running, 9 finished, here 2 minutes to 10 minutes ago.
    const twelve = [
        ...Array.from({ length: 9 }, (_, i) => row(`d${i}`, "done", Now - 20 * Minute, Now - (2 + i) * Minute)),
        row("r1", "working", Now - 3 * Minute),
        row("r2", "working", Now - 2 * Minute),
        row("r3", "idle", Now - Minute),
    ];

    it("lists the running ones and the ones that ended less than 5 minutes ago", () => {
        const g = subagentGroups(twelve, Now, false, {});
        expect(g.running.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
        expect(g.lingering.map((r) => r.id)).toEqual(["d0", "d1", "d2"]);
        expect(g.working).toBe(2);
    });

    it("drops a finished one 5 minutes after it ended, to the millisecond", () => {
        const one = [row("a", "done", Now - 9 * Minute, Now - SubagentLingerMs + 1)];
        expect(subagentGroups(one, Now, false, {}).lingering).toHaveLength(1);
        expect(subagentGroups(one, Now + 1, false, {}).lingering).toHaveLength(0);
        expect(subagentGroups(one, Now + 60 * Minute, false, {}).lingering).toHaveLength(0);
    });

    it("drops a stopped one the same way, and one with no recorded end at once", () => {
        expect(subagentGroups([row("s", "done", Now - Minute, Now - Minute)], Now, false, {}).lingering).toHaveLength(
            1
        );
        expect(subagentGroups([row("n", "done", Now - Minute, 0)], Now, false, {}).lingering).toHaveLength(0);
    });

    it("keeps a failed one until it is seen, however long ago it ended", () => {
        const failed = [row("f", "error", Now - 90 * Minute, Now - 80 * Minute)];
        expect(subagentGroups(failed, Now, false, {}).lingering.map((r) => r.id)).toEqual(["f"]);
        expect(subagentGroups(failed, Now + 24 * 60 * Minute, false, {}).lingering).toHaveLength(1);
        expect(subagentGroups(failed, Now, true, {}).lingering).toHaveLength(1);
        expect(
            subagentGroups(failed, Now, false, { f: `${failed[0].started}:${failed[0].ended}` }).lingering
        ).toHaveLength(0);
    });

    it("drops a failure as soon as it is seen, even one that just ended", () => {
        const failed = [row("f", "error", Now - 3 * Minute, Now - Minute)];
        expect(
            subagentGroups(failed, Now, false, { f: `${failed[0].started}:${failed[0].ended}` }).lingering
        ).toHaveLength(0);
    });

    it("lists no finished one once the parent stops, and still the running ones", () => {
        const g = subagentGroups(twelve, Now, true, {});
        expect(g.lingering).toEqual([]);
        expect(g.running).toHaveLength(3);
    });
});

describe("nextSubagentExpiry", () => {
    const Now = Date.UTC(2026, 9, 30, 12, 0, 0);
    const row = (id: string, state: SubagentRow["state"], ended: number): SubagentRow => ({
        id,
        name: id,
        kind: "",
        model: "",
        state,
        ended,
    });

    it("tells when the earliest finished one leaves, and ignores the running and the failed", () => {
        const rows = [
            row("a", "done", Now - 60_000),
            row("b", "done", Now - 200_000),
            row("c", "error", Now - 10_000),
            row("d", "working", 0),
            row("old", "done", Now - SubagentLingerMs - 1),
        ];
        expect(nextSubagentExpiry(rows, Now)).toBe(SubagentLingerMs - 200_000);
        expect(nextSubagentExpiry([rows[2], rows[3], rows[4]], Now)).toBeNull();
        expect(nextSubagentExpiry([], Now)).toBeNull();
    });
});

describe("subagentCardGroups", () => {
    const row = (id: string, state: SubagentRow["state"], ended = 0): SubagentRow => ({
        id,
        name: id,
        kind: "",
        model: "",
        state,
        started: 1,
        ended,
    });

    it("puts the running first, then the failures not yet seen, and folds the rest", () => {
        const rows = [
            row("d1", "done", 10),
            row("d2", "done", 30),
            row("f1", "error", 20),
            row("f2", "error", 25),
            row("r", "working"),
        ];
        const g = subagentCardGroups(rows, { f2: "1:25" });
        expect(g.running.map((r) => r.id)).toEqual(["r"]);
        expect(g.unseen.map((r) => r.id)).toEqual(["f1"]);
        expect(g.finished.map((r) => r.id)).toEqual(["d2", "f2", "d1"]);
        expect(g.working).toBe(1);
    });
});

describe("subagentDays", () => {
    const row = (id: string, ended: number): SubagentRow => ({
        id,
        name: id,
        kind: "",
        model: "",
        state: "done",
        ended,
    });
    const Now = new Date(2026, 9, 30, 15, 0, 0).getTime();

    it("groups the finished ones by the local day they ended, latest day first, unknown last", () => {
        const days = subagentDays(
            [
                row("none", 0),
                row("yesterday", new Date(2026, 9, 29, 23, 0, 0).getTime()),
                row("t1", new Date(2026, 9, 30, 9, 0, 0).getTime()),
                row("t2", new Date(2026, 9, 30, 1, 0, 0).getTime()),
                row("old", new Date(2026, 9, 20, 9, 0, 0).getTime()),
            ],
            Now
        );
        expect(days.map((d) => [d.daysAgo, d.rows.map((r) => r.id)])).toEqual([
            [0, ["t1", "t2"]],
            [1, ["yesterday"]],
            [10, ["old"]],
            [-1, ["none"]],
        ]);
    });

    it("names today and yesterday in the interface language, and the other days by their date", () => {
        expect(subagentDayLabel({ daysAgo: 0, day: 0, rows: [] }, "en")).toBe("Today");
        expect(subagentDayLabel({ daysAgo: 1, day: 0, rows: [] }, "fr")).toBe("Hier");
        expect(subagentDayLabel({ daysAgo: 10, day: new Date(2026, 9, 20).getTime(), rows: [] }, "en")).toContain("20");
        expect(subagentDayLabel({ daysAgo: -1, day: 0, rows: [] }, "en")).toBe("");
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
