// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a terminal proposes (FR-SHELL-052): the hook setup offer (#221), Update terminal (FR-SHELL-041) and the
// worktree link offer (FR-SHELL-016) left the header for the command panel's suggestions row. The header still hosts
// their dialogs (they keep their state there); the panel asks for one through a request, and a dot on the panel's
// trigger says a proposal waits.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { AgentHookOffers } from "../agent-hooks-store";
import { TermUpdates } from "../termupdate/termupdate-store";

export type ProposalKind = "hooks" | "termupdate";

export type ProposalRequest = { blockId: string; kind: ProposalKind; seq: number };

export class HeaderProposals {
    private static instance: HeaderProposals = null;

    requestAtom = atom(null) as PrimitiveAtom<ProposalRequest>;
    // The worktree a terminal's folder entered without being linked to it, published by its header's context (which
    // already probes the folder).
    worktreeOfferAtoms = new Map<string, PrimitiveAtom<string>>();
    hasProposalAtoms = new Map<string, Atom<boolean>>();
    seq = 0;

    private constructor() {}

    static getInstance(): HeaderProposals {
        if (HeaderProposals.instance == null) {
            HeaderProposals.instance = new HeaderProposals();
        }
        return HeaderProposals.instance;
    }

    worktreeOfferAtom(blockId: string): PrimitiveAtom<string> {
        let rtn = this.worktreeOfferAtoms.get(blockId);
        if (rtn == null) {
            rtn = atom("") as PrimitiveAtom<string>;
            this.worktreeOfferAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    setWorktreeOffer(blockId: string, path: string) {
        const offerAtom = this.worktreeOfferAtom(blockId);
        if (globalStore.get(offerAtom) !== (path ?? "")) {
            globalStore.set(offerAtom, path ?? "");
        }
    }

    hasProposalAtom(blockId: string): Atom<boolean> {
        let rtn = this.hasProposalAtoms.get(blockId);
        if (rtn == null) {
            const hooks = AgentHookOffers.getInstance().visibleAtom(blockId);
            const outdated = TermUpdates.getInstance().blockAtom(blockId);
            const worktree = this.worktreeOfferAtom(blockId);
            rtn = atom((get) => get(hooks) != null || get(outdated) != null || get(worktree) !== "");
            this.hasProposalAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    request(blockId: string, kind: ProposalKind) {
        this.seq++;
        globalStore.set(this.requestAtom, { blockId, kind, seq: this.seq });
    }
}

// Runs handler once per request for this terminal and kind (the panel's suggestion was chosen).
export function useProposalRequest(blockId: string, kind: ProposalKind, handler: () => void) {
    const proposals = HeaderProposals.getInstance();
    const request = useAtomValue(proposals.requestAtom);
    const handled = useRef(0);
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    useEffect(() => {
        if (
            request == null ||
            request.blockId !== blockId ||
            request.kind !== kind ||
            request.seq === handled.current
        ) {
            return;
        }
        handled.current = request.seq;
        globalStore.set(proposals.requestAtom, null);
        handlerRef.current();
    }, [request, blockId, kind]);
}
