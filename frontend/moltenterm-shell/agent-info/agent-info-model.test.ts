// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HandoffHistoryEntry } from "../agent-links/agent-links-model";
import { linkedAgents, mcpServerRows, sharedPages, startedAgo, subagentRows } from "./agent-info-model";

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
        expect(rows).toEqual([
            { id: "2", name: "Code review", kind: "general-purpose", model: "Opus 5.5", state: "working" },
            { id: "3", name: "worker", kind: "worker", model: "", state: "error" },
            { id: "1", name: "Screen inventory", kind: "Explore", model: "Haiku 5.5", state: "done" },
        ]);
        expect(subagentRows(null)).toEqual([]);
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
