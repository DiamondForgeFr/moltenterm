// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    outdated: null as unknown,
    offer: null as unknown,
    linked: [] as { blockId: string; path: string }[],
}));

vi.mock("@/app/store/jotaiStore", async () => {
    const { createStore } = await import("jotai");
    return { globalStore: createStore() };
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
