// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The terminal's hook proposal host stays in the initial bundle; the shared dialog loads only when a proposal opens.

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useState } from "react";
import { hookOfferQueryKey } from "./agent-hooks-model";
import { AgentHookOffers } from "./agent-hooks-store";
import { AgentStates } from "./agent-state-store";
import { useProposalRequest } from "./header/header-proposals";

const AgentHookOfferDialog = lazy(() => import("./agent-hooks-ui").then((m) => ({ default: m.AgentHookOfferDialog })));

export function AgentHookOfferHost({ blockId }: { blockId: string }) {
    const offers = AgentHookOffers.getInstance();
    const info = useAtomValue(AgentStates.getInstance().blockAtom(blockId));
    const offer = useAtomValue(offers.visibleAtom(blockId));
    const [open, setOpen] = useState(false);
    const queryKey = hookOfferQueryKey(info);
    useEffect(() => {
        if (!queryKey) {
            return;
        }
        fireAndForget(() => offers.refresh(blockId));
    }, [blockId, queryKey]);
    useProposalRequest(blockId, "hooks", () => setOpen(offer != null));
    if (offer == null || !open) {
        return null;
    }
    const dismiss = () => {
        setOpen(false);
        fireAndForget(() => offers.dismiss(offer.agent, offer.updatekind ? offer.updatekey : undefined));
    };
    return (
        <Suspense fallback={null}>
            <AgentHookOfferDialog blockId={blockId} offer={offer} onClose={() => setOpen(false)} onDismiss={dismiss} />
        </Suspense>
    );
}
