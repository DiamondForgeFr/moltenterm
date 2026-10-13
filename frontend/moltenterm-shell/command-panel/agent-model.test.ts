// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: async (command: string, data: unknown) => {
            if (command === "moltenagentinput") {
                sent.push(data);
                return { result: "sent", message: "Sent /model sonnet to Claude Code." };
            }
            return null;
        },
    },
}));
vi.mock("@/app/store/global", () => ({
    globalStore: { get: () => 0, set: () => {} },
    getFocusedBlockId: () => null,
    refocusNode: () => {},
}));

import { AgentStateInfo } from "../agent-state-model";
import { AgentInputInfo, agentSection, ClaudeCommands, CodexCommands, modelItem, ModelItemId } from "./agent-commands";
import { AgentInputs } from "./agent-input-store";
import { choiceValueLabel } from "./panel-model";
import { PanelChoice } from "./panel-types";
import { agentProviderSections } from "./providers/agent";

const claude: AgentStateInfo = {
    blockid: "b1",
    agent: "claude",
    agentname: "Claude Code",
    state: "idle",
    version: 1,
    model: "claude-opus-5-5",
    modelname: "Opus 5.5",
    effort: "medium",
};
const codex: AgentStateInfo = {
    blockid: "b1",
    agent: "codex",
    agentname: "Codex",
    state: "idle",
    version: 1,
    model: "gpt-test",
    effort: "high",
};
const claudeInfo: AgentInputInfo = {
    blockid: "b1",
    models: [
        { id: "fable", label: "Fable (latest)" },
        { id: "opus", label: "Opus (latest)" },
        { id: "sonnet", label: "Sonnet (latest)" },
        { id: "haiku", label: "Haiku (latest)" },
    ],
};

function handlers() {
    return {
        run: vi.fn(async () => "close" as const),
        setMode: vi.fn(async () => "close" as const),
        setEffort: vi.fn(async () => "close" as const),
        setModel: vi.fn(async () => "close" as const),
    };
}

const claudeModelDef = ClaudeCommands.find((c) => c.action === "model");
const codexModelDef = CodexCommands.find((c) => c.action === "model");

describe("model in the command panel (#573)", () => {
    it("is a choice with the reported model checked, then the agent's aliases, then its picker", () => {
        const h = handlers();
        const item = modelItem(claude, claudeInfo, claudeModelDef, h);
        expect(item.id).toBe(ModelItemId);
        expect(item.label).toBe("Model");
        expect(choiceValueLabel(item)).toBe("Opus 5.5");
        expect(item.options.map((o) => o.label)).toEqual([
            "Opus 5.5",
            "Fable (latest)",
            "Opus (latest)",
            "Sonnet (latest)",
            "Haiku (latest)",
            "Choose in Claude Code",
        ]);
        expect(item.options[0]).toMatchObject({ checked: true, disabled: true, detail: "claude-opus-5-5" });
        expect(item.options[3].detail).toBe("Saved as your default");
        item.options[3].run();
        expect(h.setModel).toHaveBeenCalledWith("sonnet");
        item.options[5].run();
        expect(h.run).toHaveBeenCalledWith("model");
    });

    it("offers only the picker before the agent reported a model or listed aliases", () => {
        const item = modelItem({ ...claude, model: "", modelname: "" }, null, claudeModelDef, handlers());
        expect(item.options.map((o) => o.label)).toEqual(["Choose in Claude Code"]);
        expect(choiceValueLabel(item)).toBe("");
    });

    it("falls back to Codex's own picker", () => {
        const h = handlers();
        const item = modelItem(codex, { blockid: "b1" }, codexModelDef, h);
        expect(item.options.map((o) => o.label)).toEqual(["gpt-test", "Choose in Codex"]);
        expect(item.options[1].detail).toBe("/model");
        item.options[1].run();
        expect(h.run).toHaveBeenCalledWith("model");
        expect(h.setModel).not.toHaveBeenCalled();
    });

    it("sits right above Effort in both agents' sections", () => {
        for (const [agent, info] of [
            [claude, claudeInfo],
            [codex, null],
        ] as const) {
            const ids = agentSection(agent, info, handlers()).items.map((i) => i.id);
            expect(ids.indexOf("agent:effort")).toBe(ids.indexOf(ModelItemId) + 1);
        }
    });

    it("sends the alias through the guarded agent input and reads the panel facts again", async () => {
        const inputs = AgentInputs.getInstance();
        inputs.infos.set("b1", { info: claudeInfo, at: Date.now() });
        const sections = agentProviderSections({
            blockId: "b1",
            view: "term",
            meta: {},
            viewModel: null,
            agent: claude,
            capabilities: new Set(),
            kindLabel: "terminals",
            panelName: "Terminal",
        } as never);
        const item = sections[0].items.find((i) => i.id === ModelItemId) as PanelChoice;
        const result = await item.options.find((o) => o.id === "model:sonnet").run();
        expect(result).toBe("close");
        expect(sent).toEqual([{ blockid: "b1", agent: "claude", action: "model", model: "sonnet" }]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        // The fake wavesrv answers the new read with nothing: the aliases read before the switch are gone.
        expect(inputs.infos.get("b1")?.info ?? null).toBeNull();
    });
});
