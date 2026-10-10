// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A terminal's proposals in the command panel's suggestions row (FR-SHELL-052): they left the header, which keeps one
// pill for the panel's state. Update terminal (FR-SHELL-041) and the hook setup (#221) open their dialog in the
// header; the worktree link (FR-SHELL-016) links at once. A waiting agent's question comes first (agent.ts): the
// Agent kind is collected before the MoltenTerm one.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { AgentHookOffers } from "../../agent-hooks-store";
import { HeaderProposals } from "../../header/header-proposals";
import { TermUpdates } from "../../termupdate/termupdate-store";
import { pathBaseName } from "../../workspace-project";
import { linkWorktree } from "../../worktree-store";
import { CommandProvider, PanelContext, PanelSuggestion } from "../panel-types";

export function proposalSuggestions(ctx: PanelContext): PanelSuggestion[] {
    const proposals = HeaderProposals.getInstance();
    const blockId = ctx.blockId;
    const rtn: PanelSuggestion[] = [];
    if (globalStore.get(TermUpdates.getInstance().blockAtom(blockId)) != null) {
        rtn.push({
            id: "molten:termupdate",
            label: "Update terminal",
            icon: "arrows-rotate",
            tone: "accent",
            run: () => proposals.request(blockId, "termupdate"),
        });
    }
    const offer = globalStore.get(AgentHookOffers.getInstance().visibleAtom(blockId));
    if (offer != null) {
        rtn.push({
            id: "molten:hooks",
            label: `Set up ${offer.agentname || offer.agent}'s hooks`,
            icon: "plug",
            tone: "accent",
            run: () => proposals.request(blockId, "hooks"),
        });
    }
    const worktree = globalStore.get(proposals.worktreeOfferAtom(blockId));
    if (worktree) {
        rtn.push({
            id: "molten:worktree",
            label: `Link the worktree ${pathBaseName(worktree) || worktree}`,
            icon: "link",
            tone: "accent",
            run: () => fireAndForget(() => linkWorktree(blockId, worktree)),
        });
    }
    return rtn;
}

export const ProposalsProvider: CommandProvider = {
    id: "molten:proposals",
    kind: "molten",
    needs: ["terminal"],
    sections: () => [],
    suggestions: proposalSuggestions,
};
