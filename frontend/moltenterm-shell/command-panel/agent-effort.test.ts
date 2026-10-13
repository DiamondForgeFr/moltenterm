// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { agentEffortTitle, agentModelEffortLabel, agentModelTitle, AgentStateInfo } from "../agent-state-model";
import { agentSection, EffortAction, effortItem, feedbackFor } from "./agent-commands";
import { choiceValueLabel } from "./panel-model";
import { PanelChoice, PanelFeedback } from "./panel-types";

const claude: AgentStateInfo = {
    blockid: "b1",
    agent: "claude",
    agentname: "Claude Code",
    state: "idle",
    version: 1,
    model: "claude-opus-5-5",
    modelname: "Opus",
    effort: "high",
};
const codex: AgentStateInfo = { blockid: "b1", agent: "codex", agentname: "Codex", state: "idle", version: 1 };

function handlers() {
    return {
        run: vi.fn(async () => "close" as const),
        setMode: vi.fn(async () => "close" as const),
        setEffort: vi.fn(async () => "close" as const),
    };
}

describe("effort in the command panel (#549)", () => {
    it("sits below Model and shows the reported level", () => {
        const h = handlers();
        const section = agentSection(claude, { blockid: "b1", efforts: ["low", "medium", "high", "xhigh", "max"] }, h);
        const ids = section.items.map((i) => i.id);
        expect(ids.indexOf("agent:effort")).toBe(ids.indexOf("agent:model") + 1);
        const item = section.items.find((i) => i.id === "agent:effort") as PanelChoice;
        expect(item.label).toBe("Effort");
        expect(choiceValueLabel(item)).toBe("high");
        expect(item.options.map((o) => o.label)).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(item.options.find((o) => o.label === "max").detail).toBe("This session");
        expect(item.options.find((o) => o.label === "low").detail).toBe("Saved as your default");
        item.options[3].run();
        expect(h.setEffort).toHaveBeenCalledWith("xhigh");
    });

    it("shows no value when the agent reported none", () => {
        const item = effortItem(
            { ...claude, effort: undefined },
            { blockid: "b1", efforts: ["low", "high"] },
            "claude",
            handlers()
        );
        expect(choiceValueLabel(item)).toBe("");
        expect(item.options.every((o) => !o.checked)).toBe(true);
    });

    it("offers Codex's own picker while its level is unknown", () => {
        const h = handlers();
        const item = effortItem(codex, { blockid: "b1" }, "codex", h);
        expect(item.options.map((o) => o.label)).toEqual(["Choose in Codex"]);
        item.options[0].run();
        expect(h.run).toHaveBeenCalledWith("model");
        const known = effortItem({ ...codex, effort: "xhigh" }, { blockid: "b1", efforts: [] }, "codex", h);
        expect(choiceValueLabel(known)).toBe("xhigh");
        expect(known.options[0].disabled).toBe(true);
    });

    it("keeps the panel open on Codex's answer, closes on Claude Code's", () => {
        const fb = { interrupt: vi.fn(), confirmDraft: vi.fn(), openModel: vi.fn() } as any;
        const codexSent = feedbackFor(
            { result: "sent", message: "Codex is set to high effort for this session.", presses: 2, effort: "high" },
            EffortAction,
            fb
        ) as PanelFeedback;
        expect(codexSent.tone).toBe("muted");
        expect(codexSent.message).toContain("this session");
        expect(feedbackFor({ result: "sent", message: "Sent /effort high", effort: "high" }, EffortAction, fb)).toBe(
            "close"
        );
        const unknown = feedbackFor(
            {
                result: "refused",
                reason: "effortunknown",
                message: "MoltenTerm does not know Codex's effort level yet",
            },
            EffortAction,
            fb
        ) as PanelFeedback;
        expect(unknown.tone).toBe("warning");
        expect(unknown.actions.map((a) => a.label)).toEqual(["Open /model"]);
    });
});

describe("model and effort label", () => {
    it("says only what the agent reported", () => {
        expect(agentModelEffortLabel(claude)).toBe("Opus · high");
        expect(agentModelEffortLabel({ ...claude, effort: "" })).toBe("Opus");
        expect(agentModelEffortLabel({ ...codex, model: "gpt-6.1-sol", effort: "xhigh" })).toBe("gpt-6.1-sol · xhigh");
        expect(agentModelEffortLabel({ ...claude, model: "", modelname: "" })).toBe("");
        expect(agentModelEffortLabel(null)).toBe("");
        expect(agentModelTitle(claude)).toContain("Opus (claude-opus-5-5)");
        expect(agentEffortTitle(claude)).toContain("Effort: high");
        expect(agentEffortTitle({ ...claude, effort: "" })).toBe("");
    });
});
