// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", () => ({ useSettingsKeyAtom: () => "" }));
vi.mock("@/util/platformutil", () => ({ PLATFORM: "darwin" }));
vi.mock("./keepawake-store", () => ({ KeepAwakeModel: { getInstance: () => ({}) } }));

import {
    applyKeepAwakeState,
    approvalSummary,
    coffeeApprovalLines,
    coffeeApprovals,
    describeApproval,
    EmptyKeepAwakeState,
    KeepAwakeApproval,
    KeepAwakeCoffee,
    KeepAwakeState,
} from "./keepawake-model";
import { CoffeeApprovals } from "./keepawake-ui";

const coffee: KeepAwakeCoffee = { workspaceid: "ws-a", workspacename: "Alpha", since: 0, working: true };

function approval(partial: Partial<KeepAwakeApproval>): KeepAwakeApproval {
    return { id: "p1", at: 0, workspaceid: "ws-a", blockid: "b1", tool: "Bash", outcome: "approved", ...partial };
}

function state(partial: Partial<KeepAwakeState>): KeepAwakeState {
    return { ...EmptyKeepAwakeState, version: 1, coffees: [coffee], ...partial };
}

const sessions = [
    { workspaceid: "ws-a", blockid: "b1", tabname: "Tab 1", agent: "claude", agentname: "Claude Code", approved: true },
    {
        workspaceid: "ws-a",
        blockid: "b2",
        tabname: "Tab 2",
        agent: "codex",
        agentname: "Codex",
        approved: false,
        reason: "MoltenTerm cannot answer Codex's approvals yet",
    },
    { workspaceid: "ws-b", blockid: "b3", agent: "claude", agentname: "Claude Code", approved: true },
];

describe("coffee approvals (FR-SHELL-063)", () => {
    it("reads a state without the approval fields", () => {
        const next = applyKeepAwakeState(EmptyKeepAwakeState, { version: 2, coffees: [] } as KeepAwakeState);
        expect(next.autoapprove).toEqual([]);
        expect(next.approvals).toEqual([]);
    });

    it("tells the bud who is approved and who still asks, for its own workspace only (AC6)", () => {
        expect(coffeeApprovalLines(state({ autoapprove: sessions }), "ws-a")).toEqual([
            "Approves the agents' requests: Claude Code in Tab 1",
            "Still asks: Codex in Tab 2 (MoltenTerm cannot answer Codex's approvals yet)",
        ]);
        expect(coffeeApprovalLines(state({ autoapprove: sessions }), "ws-c")).toEqual([]);
    });

    it("counts and describes the decisions (AC5)", () => {
        const approvals = [
            approval({ id: "p3", detail: "npm test" }),
            approval({
                id: "p2",
                outcome: "asked",
                detail: "rm -rf ~/x",
                reason: "deletes outside the session's folder: ~/x",
            }),
            approval({ id: "p1", workspaceid: "ws-b" }),
        ];
        const mine = coffeeApprovals(state({ approvals }), "ws-a");
        expect(mine.map((a) => a.id)).toEqual(["p3", "p2"]);
        expect(approvalSummary(mine)).toBe("1 approved · 1 left to you");
        expect(approvalSummary([])).toBe("");
        expect(describeApproval(mine[0])).toBe("Bash: npm test");
        expect(describeApproval(approval({ tool: "AskUserQuestion" }))).toBe("AskUserQuestion");
    });

    it("lists the sessions and the latest decisions under the coffee", () => {
        const html = renderToStaticMarkup(
            <CoffeeApprovals
                state={state({
                    autoapprove: sessions,
                    approvals: [
                        approval({
                            id: "p2",
                            outcome: "asked",
                            detail: "cat .env",
                            reason: "reads or writes a credential file: .env",
                        }),
                        approval({ id: "p1", detail: "go test ./..." }),
                    ],
                })}
                coffee={coffee}
            />
        );
        expect(html).toContain("Agents&#x27; requests in Alpha");
        expect(html).toContain("Claude Code in Tab 1");
        expect(html).toContain("approved automatically");
        expect(html).toContain("still asks you: MoltenTerm cannot answer Codex&#x27;s approvals yet");
        expect(html).toContain("1 approved · 1 left to you");
        expect(html).toContain("Bash: go test ./...");
        expect(html).toContain("reads or writes a credential file: .env");
        expect(html).toContain("molten/coffee-approvals.jsonl");
        expect(html).not.toContain("b3");
    });

    it("shows nothing for a coffee with no agent and no decision", () => {
        expect(renderToStaticMarkup(<CoffeeApprovals state={state({})} coffee={coffee} />)).toBe("");
    });
});
