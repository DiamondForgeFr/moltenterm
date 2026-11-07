// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk at the collapsed sidebar's edge, as the sidebar reads it (FR-BOSS-009, AC27 to AC30, #2070): where the sidebar
// stands for him, how open it stays, and the bounce a new notification plays on it. The rules are brokk-edge-model.ts's.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { BossBubbleModel } from "./boss-store";
import { Bounce, bounceOnNews, EdgeShape, edgeShapeOf, SidebarPlace } from "./brokk-edge-model";
import { BrokkEdgeModel } from "./brokk-edge-store";
import { BrokkHubModel } from "./brokk-hub-store";
import { useAvatarKeys, useHubSelect } from "./use-brokk-hub";

export function useBrokkEdge(asideRef: React.RefObject<HTMLElement>): { place: SidebarPlace; shape: EdgeShape } {
    const hubModel = BrokkHubModel.getInstance();
    const edgeModel = BrokkEdgeModel.getInstance();
    const place = useAtomValue(hubModel.sidebarPlaceAtom, { store: globalStore });
    const cardOpen = useAtomValue(BossBubbleModel.getInstance().cardOpenAtom, { store: globalStore });
    const bounce = useAtomValue(edgeModel.bounceAtom, { store: globalStore });
    const keys = useAvatarKeys();
    const ready = useHubSelect((view) => view.ready);
    const visit = useHubSelect((view) => view.visit != null);
    const cue = useHubSelect((view) => view.cue);
    const played = useRef(bounce);
    const bouncing = useRef<Bounce>(null);
    // Looking at the badge is being able to: the sidebar is on screen, or his group is open.
    const looking = place !== "edge" || cardOpen;
    const keysKey = keys.join("\n");

    useEffect(() => edgeModel.tell(keys, looking, ready), [edgeModel, keysKey, looking, ready]);
    useEffect(() => {
        const step = bounceOnNews(bounce, played.current, asideRef.current, prefersReducedMotion());
        played.current = step.played;
        if (step.bounce != null) {
            bouncing.current = step.bounce;
        }
    }, [bounce, asideRef]);
    useEffect(() => {
        if (place !== "edge") {
            bouncing.current?.cancel();
            bouncing.current = null;
        }
    }, [place]);

    return { place, shape: edgeShapeOf(place, { visit, cue }) };
}
