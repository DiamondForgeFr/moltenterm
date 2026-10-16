// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it, vi } from "vitest";
import { effectiveValue } from "../command-panel/panel-model";
import { PanelChoice, PanelContext } from "../command-panel/panel-types";
import { codingAgentItem, codingAgentSections, CodingAgentViews } from "../command-panel/providers/coding-agent";
import { ReviewTabModel } from "../review/review-tab-model";
import {
    CodingAgentChoice,
    codingAgentDetail,
    CodingAgentModel,
    codingAgentOptions,
    fetchCodingAgent,
} from "./coding-agent";

vi.mock("./coding-agent", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./coding-agent")>();
    return { ...actual, fetchCodingAgent: vi.fn() };
});

const both = [
    { id: "claude", name: "Claude Code", installed: true },
    { id: "codex", name: "Codex", installed: true },
];

function known(dir: string, choice: CodingAgentChoice) {
    const model = CodingAgentModel.getInstance();
    globalStore.set(model.choicesAtom, { ...globalStore.get(model.choicesAtom), [dir]: { choice, at: Date.now() } });
}

describe("the Agent option (#845)", () => {
    it("lists the agents, greys the ones not installed, and says what no choice gives", () => {
        const choice: CodingAgentChoice = {
            agent: "claude",
            source: "order",
            order: "claude",
            agents: [both[0], { id: "codex", name: "Codex", installed: false }],
        };
        expect(codingAgentOptions(choice)).toEqual([
            { id: "codingagent:claude", label: "Claude Code", value: "claude", disabled: false, detail: undefined },
            { id: "codingagent:codex", label: "Codex", value: "codex", disabled: true, detail: "not installed" },
        ]);
        expect(codingAgentDetail(choice)).toBe("Automatic: Claude Code");
        expect(codingAgentDetail({ ...choice, source: "project", chosen: "claude" })).toBeUndefined();
        expect(
            codingAgentDetail({ source: "project", chosen: "codex", chosenname: "Codex", missing: true, agents: [] })
        ).toBe("Codex is chosen but not installed on this computer: choose another one");
    });

    it("is one choice per project with a global default, in every panel that starts an agent", () => {
        known("/p", { agent: "claude", source: "order", order: "claude", agents: both });
        const item = codingAgentItem("/p") as PanelChoice;
        expect(item.scopes.map((s) => s.scope)).toEqual(["project", "global"]);
        expect(effectiveValue(item)).toBe("claude");
        expect(item.detail).toBe("Automatic: Claude Code");
        for (const view of ["molten-reviews", "molten-review", "molten-project"]) {
            expect(CodingAgentViews.has(view)).toBe(true);
        }
        const ctx = { view: "molten-review", meta: { "molten:review": { dir: "/p" } } } as unknown as PanelContext;
        expect(codingAgentSections(ctx)[0].items[0]).toMatchObject({ id: "codingagent", label: "Agent" });
    });
});

describe("the assisted review's agent (#845 AC2)", () => {
    it("sends the project's choice, the missing chosen one as is, or the developer's pick", async () => {
        const sessionAgent = ReviewTabModel.prototype.sessionAgent;
        vi.mocked(fetchCodingAgent).mockResolvedValueOnce({
            agent: "codex",
            source: "project",
            chosen: "codex",
            agents: both,
        });
        await expect(sessionAgent.call(null, "/p")).resolves.toBe("codex");
        vi.mocked(fetchCodingAgent).mockResolvedValueOnce({
            source: "global",
            chosen: "codex",
            missing: true,
            agents: both,
        });
        await expect(sessionAgent.call(null, "/p")).resolves.toBe("codex");
        await expect(sessionAgent.call(null, "/p", "claude")).resolves.toBe("claude");
        vi.mocked(fetchCodingAgent).mockRejectedValueOnce(new Error("no route"));
        await expect(sessionAgent.call(null, "/p")).resolves.toBeUndefined();
    });
});
