// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { attachCandidates, companionAgent, DefaultCompanionAgent, shellAtPrompt } from "./companion-attach";

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

    it("starts the Claude Code preset as configured, the default without one", () => {
        expect(companionAgent({})).toEqual(DefaultCompanionAgent);
        expect(companionAgent(null)).toEqual(DefaultCompanionAgent);
        expect(
            companionAgent({
                "agent@claude": { "display:name": "Claude Code", "agent:command": "claude --verbose" } as MetaType,
            })
        ).toEqual({ name: "Claude Code", command: "claude --verbose" });
    });

    it("types into the terminal only while its shell waits at the prompt", () => {
        expect(shellAtPrompt({ "shell:state": "ready" } as ObjRTInfo)).toBe(true);
        expect(shellAtPrompt({ "shell:state": "running-command" } as ObjRTInfo)).toBe(false);
        expect(shellAtPrompt({} as ObjRTInfo)).toBe(false);
        expect(shellAtPrompt(null)).toBe(false);
    });
});
