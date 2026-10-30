// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { CodingAgentChoice } from "../coding-agent/coding-agent";
import {
    attachCandidates,
    cleanCustomCommand,
    companionAgent,
    CompanionAgentMetaKey,
    companionStartPlan,
    CompanionStartPlan,
    nextCompanionAgentMemory,
    readCompanionAgentMemory,
    shellAtPrompt,
} from "./companion-attach";

vi.mock("@/app/store/global", () => ({ atoms: {}, createBlockSplitHorizontally: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/tab-model", () => ({ getActiveTabModel: () => null }));
vi.mock("../palette/palette-actions", () => ({ AgentBlockDef: {}, typeCommandWhenReady: vi.fn() }));

const block = (oid: string, meta: MetaType): Block => ({ oid, meta }) as Block;

describe("companion attach (FR-SHELL-053-AC1)", () => {
    it("lists the tab's terminals in order, named by their folder, the current one marked", () => {
        const blocks = [
            block("t1", { view: "term", "cmd:cwd": "/Users/me/code/app" }),
            block("c1", { view: "molten-companion" }),
            block("w1", { view: "web" }),
            block("t2", { view: "term", connection: "me@server", "cmd:cwd": "/srv/api" }),
            block("t3", { view: "term" }),
        ];
        expect(attachCandidates(blocks, "t2")).toEqual([
            { blockId: "t1", label: "Terminal 1 · app", current: false },
            { blockId: "t2", label: "Terminal 2 · api · me@server", current: true },
            { blockId: "t3", label: "Terminal 3 · ~", current: false },
        ]);
        expect(attachCandidates([], null)).toEqual([]);
    });

    it("#1460: presumes no agent, a preset as configured otherwise", () => {
        expect(companionAgent({})).toBeNull();
        expect(companionAgent(null)).toBeNull();
        expect(companionAgent({}, "claude")).toEqual({ name: "Claude Code", command: "claude" });
        expect(
            companionAgent(
                {
                    "agent@claude": { "display:name": "Claude Code", "agent:command": "claude --verbose" } as MetaType,
                },
                "claude"
            )
        ).toEqual({ name: "Claude Code", command: "claude --verbose" });
    });

    it("#1460: names a known agent by the registry's name and program", () => {
        expect(companionAgent({}, "gemini", [{ id: "gemini", name: "Gemini CLI", command: "gemini" }])).toEqual({
            name: "Gemini CLI",
            command: "gemini",
        });
    });

    it("#845: starts the project's coding agent, its preset when it has one", () => {
        expect(companionAgent({}, "codex")).toEqual({ name: "Codex", command: "codex" });
        expect(
            companionAgent(
                { "agent@codex": { "display:name": "Codex", "agent:command": "codex --full-auto" } as MetaType },
                "codex"
            )
        ).toEqual({ name: "Codex", command: "codex --full-auto" });
    });

    describe("#1460: the start button never presumes an agent", () => {
        const agent = (id: string, installed: boolean, name = id) => ({ id, name, installed, command: id });
        const choice = (known: ReturnType<typeof agent>[], extra: Partial<CodingAgentChoice> = {}) =>
            ({ agents: [], known, source: "order", ...extra }) as CodingAgentChoice;
        const names = (plan: CompanionStartPlan) =>
            plan.kind === "menu" ? plan.options.map((o) => o.agent.name) : [plan.agent.name];

        it("opens a menu with nothing found, to name another command", () => {
            expect(companionStartPlan(choice([agent("claude", false), agent("codex", false)]), {}, {})).toEqual({
                kind: "menu",
                options: [],
            });
            expect(companionStartPlan(null, {}, {})).toEqual({ kind: "menu", options: [] });
        });

        it("starts the only agent found directly, by its name", () => {
            const plan = companionStartPlan(
                choice([agent("claude", false, "Claude Code"), agent("codex", true, "Codex")]),
                {},
                {}
            );
            expect(plan).toEqual({
                kind: "direct",
                agent: { name: "Codex", command: "codex" },
                key: "codex",
                explicit: false,
            });
        });

        it("lists every agent found, the last one used first, then the commands typed before", () => {
            const known = [agent("claude", true, "Claude Code"), agent("codex", true, "Codex"), agent("kimi", false)];
            expect(names(companionStartPlan(choice(known), {}, {}))).toEqual(["Claude Code", "Codex"]);
            expect(names(companionStartPlan(choice(known), {}, { last: "codex" }))).toEqual(["Codex", "Claude Code"]);
            expect(
                names(companionStartPlan(choice(known), {}, { last: "cmd:myagent -x", commands: ["myagent -x"] }))
            ).toEqual(["myagent -x", "Claude Code", "Codex"]);
        });

        it("a typed command alone is still a menu, so another can be named", () => {
            const plan = companionStartPlan(choice([agent("codex", true)]), {}, { commands: ["myagent"] });
            expect(plan.kind).toBe("menu");
        });

        it("starts the agent the developer chose, installed or not", () => {
            const known = [agent("claude", true, "Claude Code"), agent("codex", true, "Codex")];
            expect(
                companionStartPlan(choice(known, { source: "project", chosen: "codex", agent: "codex" }), {}, {})
            ).toEqual({
                kind: "direct",
                agent: { name: "Codex", command: "codex" },
                key: "codex",
                explicit: true,
            });
            const missing = companionStartPlan(
                choice(known, { source: "global", chosen: "kimi", missing: true }),
                {},
                {}
            );
            expect(missing).toMatchObject({ kind: "direct", explicit: true, key: "kimi" });
        });
    });

    it("#1460: remembers the last agent and the commands typed, the latest first", () => {
        let memory = nextCompanionAgentMemory({}, "codex");
        expect(memory).toEqual({ last: "codex", commands: [] });
        memory = nextCompanionAgentMemory(memory, "cmd:a");
        memory = nextCompanionAgentMemory(memory, "cmd:b");
        memory = nextCompanionAgentMemory(memory, "cmd:a");
        expect(memory).toEqual({ last: "cmd:a", commands: ["a", "b"] });
        expect(readCompanionAgentMemory({ meta: { [CompanionAgentMetaKey]: memory } } as unknown as Client)).toEqual(
            memory
        );
        expect(readCompanionAgentMemory({ meta: { [CompanionAgentMetaKey]: "x" } } as unknown as Client)).toEqual({});
        expect(readCompanionAgentMemory(null)).toEqual({});
    });

    it("#1460: takes one line of text as a command", () => {
        expect(cleanCustomCommand("  myagent --flag ")).toBe("myagent --flag");
        expect(cleanCustomCommand("")).toBe("");
        expect(cleanCustomCommand("a\nrm -rf /")).toBe("");
        expect(cleanCustomCommand("a\u0003b")).toBe("");
    });

    it("types into the terminal only while its shell waits at the prompt", () => {
        expect(shellAtPrompt({ "shell:state": "ready" } as ObjRTInfo)).toBe(true);
        expect(shellAtPrompt({ "shell:state": "running-command" } as ObjRTInfo)).toBe(false);
        expect(shellAtPrompt({} as ObjRTInfo)).toBe(false);
        expect(shellAtPrompt(null)).toBe(false);
    });
});
