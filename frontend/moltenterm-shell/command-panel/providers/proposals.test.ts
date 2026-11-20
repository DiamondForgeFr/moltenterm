// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    outdated: null as unknown,
    offer: null as unknown,
    linked: [] as { blockId: string; path: string }[],
    labels: {} as Record<string, string>,
}));

vi.mock("@/app/store/jotaiStore", async () => {
    const { createStore } = await import("jotai");
    return { globalStore: createStore() };
});
vi.mock("../../i18n/i18n", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../i18n/i18n")>();
    return {
        ...actual,
        t: (key: string, vars?: any) => {
            const label = state.labels[key];
            return label ? label.replace("{agent}", String(vars?.agent ?? "")) : actual.t(key, vars);
        },
    };
});
vi.mock("../../termupdate/termupdate-store", () => ({
    TermUpdates: {
        getInstance: () => ({ blockAtom: () => atom(() => state.outdated) }),
    },
}));
vi.mock("../../agent-hooks-store", () => ({
    AgentHookOffers: {
        getInstance: () => ({ visibleAtom: () => atom(() => state.offer) }),
    },
}));
vi.mock("../../worktree-store", () => ({
    linkWorktree: async (blockId: string, path: string) => {
        state.linked.push({ blockId, path });
    },
}));

import { globalStore } from "@/app/store/jotaiStore";
import { HeaderProposals } from "../../header/header-proposals";
import { PanelContext } from "../panel-types";
import { ProposalsProvider, proposalSuggestions } from "./proposals";

function ctx(blockId = "b1"): PanelContext {
    return { blockId, capabilities: new Set(["terminal"]) } as PanelContext;
}

describe("proposals in the command panel (FR-SHELL-052)", () => {
    beforeEach(() => {
        state.outdated = null;
        state.offer = null;
        state.linked = [];
        state.labels = {};
        HeaderProposals.getInstance().setWorktreeOffer("b1", "");
    });

    it("offers nothing when the terminal proposes nothing", () => {
        expect(proposalSuggestions(ctx())).toEqual([]);
        expect(ProposalsProvider.needs).toEqual(["terminal"]);
        expect(ProposalsProvider.sections(ctx())).toEqual([]);
    });

    it("lists Update terminal, the hook setup and the worktree link as suggestions", () => {
        state.outdated = { blockid: "b1" };
        state.offer = { agent: "claude", agentname: "Claude Code" };
        HeaderProposals.getInstance().setWorktreeOffer("b1", "/repo/.claude/worktrees/agent-a77");
        const got = proposalSuggestions(ctx());
        expect(got.map((s) => s.label)).toEqual([
            "Update terminal",
            "Set up Claude Code's hooks",
            "Link the worktree agent-a77",
        ]);
        expect(got.every((s) => s.tone === "accent")).toBe(true);
    });

    it("labels restart, definition update, repair and compatibility proposals distinctly", () => {
        state.labels = {
            "cmdpanel.proposals.restartHooks": "Restart {agent} to activate hooks",
            "cmdpanel.proposals.updateHooks": "Update MoltenTerm hooks",
            "cmdpanel.proposals.repairHooks": "Repair MoltenTerm hooks",
            "cmdpanel.proposals.reviewHooks": "Review {agent} hook compatibility",
        };
        for (const [fields, label] of [
            [{ status: "installed-not-reporting" }, "Restart Kimi Code to activate hooks"],
            [{ updatekind: "definition" }, "Update MoltenTerm hooks"],
            [{ updatekind: "repair" }, "Repair MoltenTerm hooks"],
            [{ updatekind: "compatibility" }, "Review Kimi Code hook compatibility"],
        ] as const) {
            state.offer = { agent: "kimi", agentname: "Kimi Code", ...fields };
            expect(proposalSuggestions(ctx())[0].label).toBe(label);
        }
    });

    it("asks the header to open the dialog of the proposal chosen", () => {
        state.outdated = { blockid: "b1" };
        proposalSuggestions(ctx())[0].run();
        expect(globalStore.get(HeaderProposals.getInstance().requestAtom)).toMatchObject({
            blockId: "b1",
            kind: "termupdate",
        });
    });

    it("links the worktree at once", async () => {
        HeaderProposals.getInstance().setWorktreeOffer("b1", "/repo/wt");
        await proposalSuggestions(ctx())[0].run();
        await Promise.resolve();
        expect(state.linked).toEqual([{ blockId: "b1", path: "/repo/wt" }]);
    });

    it("marks the trigger while a proposal waits", () => {
        const proposals = HeaderProposals.getInstance();
        const has = proposals.hasProposalAtom("b2");
        expect(globalStore.get(has)).toBe(false);
        proposals.setWorktreeOffer("b2", "/repo/wt");
        expect(globalStore.get(has)).toBe(true);
    });
});
