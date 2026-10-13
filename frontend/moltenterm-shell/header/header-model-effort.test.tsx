// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { wshRpcCall: async () => ({ blockid: "b1", models: [{ id: "opus", label: "Opus (latest)" }] }) },
}));
vi.mock("@/app/store/global", async () => {
    const { globalStore } = await import("@/app/store/jotaiStore");
    return { globalStore, getFocusedBlockId: () => null, refocusNode: () => {} };
});

import {
    agentEffortPart,
    agentEffortTitle,
    agentModelPart,
    agentModelTitle,
    AgentStateInfo,
} from "../agent-state-model";
import { EffortItemId, ModelItemId } from "../command-panel/agent-commands";
import { AgentInputs } from "../command-panel/agent-input-store";
import { CommandPanelModel, openCommandPanelOn } from "../command-panel/command-panel-store";
import { HeaderModelEffort } from "./header-model-effort";

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

function render(agent: AgentStateInfo): string {
    return renderToStaticMarkup(
        <HeaderModelEffort
            blockId="b1"
            model={agentModelPart(agent)}
            modelTitle={agentModelTitle(agent)}
            effort={agentEffortPart(agent)}
            effortTitle={agentEffortTitle(agent)}
        />
    );
}

describe("header model and effort (#573)", () => {
    it("draws the model and the effort as two buttons with their own titles", () => {
        const html = render(claude);
        expect(html).toMatch(
            /<button[^>]*title="Model: Opus 5.5 \(claude-opus-5-5\)\nClick to change the model"[^>]*data-testid="molten-header-model"[^>]*>Opus 5.5<\/button>/
        );
        expect(html).toMatch(
            /<button[^>]*title="Effort: medium\nClick to change the effort level"[^>]*data-testid="molten-header-effort"[^>]*>medium<\/button>/
        );
        expect(html.match(/<button type="button"/g)).toHaveLength(2);
    });

    it("shows the model alone without an effort, and nothing without a model", () => {
        const html = render({ ...claude, effort: "" });
        expect(html).toContain("molten-header-model");
        expect(html).not.toContain("molten-header-effort");
        expect(render({ ...claude, model: "", modelname: "" })).toBe("");
        expect(agentEffortPart({ ...claude, model: "", modelname: "" })).toBe("");
    });

    it("opens the command panel on the choice that was clicked", () => {
        const trigger = { getBoundingClientRect: () => ({ left: 10, top: 0, right: 40, bottom: 20 }) } as Element;
        openCommandPanelOn("b1", ModelItemId, trigger);
        let open = globalStore.get(CommandPanelModel.getInstance().openAtom);
        expect(open.stack).toEqual([ModelItemId]);
        expect(open.source).toBe("header");
        expect(open.anchor).toEqual({ kind: "rect", left: 10, top: 0, right: 40, bottom: 20 });
        openCommandPanelOn("b1", EffortItemId, trigger);
        open = globalStore.get(CommandPanelModel.getInstance().openAtom);
        expect(open.stack).toEqual([EffortItemId]);
    });

    it("reads the panel facts before opening, so the choice opens with its options", async () => {
        const inputs = AgentInputs.getInstance();
        inputs.infos.delete("b1");
        await inputs.ready("b1");
        expect(inputs.infos.get("b1").info.models).toEqual([{ id: "opus", label: "Opus (latest)" }]);
    });
});
