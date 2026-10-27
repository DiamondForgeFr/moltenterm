// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { CodingAgentChoice } from "../coding-agent/coding-agent";
import { askPipelineAgent, atPromptOf, PipelineAgentDeps, pipelineTerminalOf } from "./pipeline-agent";
import { PipelineTermMetaKey } from "./pipeline-tab-model";

const Dir = "/work/app";
const Req = { context: "Step 4: the validation request." };

function term(oid: string, meta: Record<string, unknown>): Block {
    return { oid, meta: { view: "term", ...meta } } as unknown as Block;
}

const panel = { oid: "panel", meta: { view: "molten-pipeline" } } as unknown as Block;
const tabTerm = term("term", { "cmd:cwd": Dir, [PipelineTermMetaKey]: Dir });
const fake: CodingAgentChoice = { agent: "fakeagent", source: "project", agents: [] };

// A fake tab: its blocks, and wavesrv's ask answering "noagent" until the agent was typed into a terminal.
function deps(choice: CodingAgentChoice, blocks: Block[], over: Partial<PipelineAgentDeps> = {}) {
    const running = new Set<string>();
    const asks: Record<string, unknown>[] = [];
    const d: PipelineAgentDeps = {
        choice: async () => choice,
        presets: () => ({}),
        blocks: () => blocks,
        atPrompt: async () => true,
        newTerminal: vi.fn(async () => {
            blocks = [...blocks, term("new-term", { "cmd:cwd": Dir, [PipelineTermMetaKey]: Dir })];
            return "new-term";
        }),
        type: vi.fn(async (blockId: string) => {
            running.add(blockId);
            return true;
        }),
        ask: vi.fn(async (data) => {
            asks.push(data);
            return { status: running.has(data.blockid as string) ? "sent" : "noagent" } as const;
        }),
        focus: vi.fn(),
        ...over,
    };
    return { d, asks, running };
}

describe("askPipelineAgent", () => {
    it("opens the terminal on the left, starts the agent and hands it the context", async () => {
        const { d, asks } = deps(fake, [panel]);
        expect(await askPipelineAgent(Dir, "App", "panel", Req, d)).toBe("sent");
        expect(d.newTerminal).toHaveBeenCalledWith(Dir, "panel");
        expect(d.type).toHaveBeenCalledWith("new-term", "fakeagent");
        expect(asks.at(-1)).toEqual({
            dir: Dir,
            project: "App",
            context: Req.context,
            blockid: "new-term",
            wait: true,
        });
    });

    it("reuses the tab's terminal and the agent running in it", async () => {
        const { d, running, asks } = deps(fake, [panel, tabTerm]);
        running.add("term");
        expect(await askPipelineAgent(Dir, "App", "panel", Req, d)).toBe("sent");
        expect(d.newTerminal).not.toHaveBeenCalled();
        expect(d.type).not.toHaveBeenCalled();
        expect(asks).toEqual([{ dir: Dir, project: "App", context: Req.context, blockid: "term" }]);
        expect(d.focus).toHaveBeenCalledWith("term");
    });

    it("gives the terminal the keyboard after every ask, a new one included (#1163)", async () => {
        const { d } = deps(fake, [panel]);
        await askPipelineAgent(Dir, "App", "panel", Req, d);
        expect(d.focus).toHaveBeenCalledWith("new-term");
        const busy = deps(fake, [panel, tabTerm], { atPrompt: async () => false });
        await askPipelineAgent(Dir, "App", "panel", Req, busy.d);
        expect(busy.d.focus).toHaveBeenCalledWith("term");
    });

    it("starts the agent in the tab's terminal when none runs there", async () => {
        const { d } = deps(fake, [panel, tabTerm]);
        expect(await askPipelineAgent(Dir, "App", "panel", Req, d)).toBe("sent");
        expect(d.newTerminal).not.toHaveBeenCalled();
        expect(d.type).toHaveBeenCalledWith("term", "fakeagent");
    });

    it("never types into a terminal that runs something else", async () => {
        const { d } = deps(fake, [panel, tabTerm], { atPrompt: async () => false });
        expect(await askPipelineAgent(Dir, "App", "panel", Req, d)).toBe("busy");
        expect(d.type).not.toHaveBeenCalled();
    });

    it("opens nothing when no agent is installed, or the chosen one is missing", async () => {
        const none = deps({ agents: [] }, [panel]);
        expect(await askPipelineAgent(Dir, "App", "panel", Req, none.d)).toBe("none");
        const missing = deps({ missing: true, chosen: "codex", agents: [] }, [panel]);
        expect(await askPipelineAgent(Dir, "App", "panel", Req, missing.d)).toBe("missing");
        expect(none.d.newTerminal).not.toHaveBeenCalled();
        expect(missing.d.newTerminal).not.toHaveBeenCalled();
    });

    it("says it failed when the agent never shows up", async () => {
        const { d } = deps(fake, [panel], { ask: vi.fn(async () => Promise.reject(new Error("no agent"))) });
        expect(await askPipelineAgent(Dir, "App", "panel", Req, d)).toBe("failed");
    });
});

describe("atPromptOf", () => {
    it("trusts the shell integration when there is one", () => {
        expect(atPromptOf({ "shell:integration": true, "shell:state": "ready" } as ObjRTInfo)).toBe(true);
        expect(atPromptOf({ "shell:integration": true, "shell:state": "running-command" } as ObjRTInfo)).toBe(false);
    });

    it("goes on the developer's click in a shell that reports nothing", () => {
        expect(atPromptOf({} as ObjRTInfo)).toBe(true);
        expect(atPromptOf(null)).toBe(true);
    });
});

describe("pipelineTerminalOf", () => {
    it("prefers the tab's own terminal, then one in the project's folder", () => {
        const other = term("other", { "cmd:cwd": "/elsewhere" });
        const inDir = term("indir", { "cmd:cwd": Dir });
        expect(pipelineTerminalOf([other, inDir, tabTerm], Dir)).toBe("term");
        expect(pipelineTerminalOf([other, inDir], Dir)).toBe("indir");
        expect(pipelineTerminalOf([other], Dir)).toBe("");
    });
});
