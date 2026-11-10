// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk at the collapsed sidebar's edge, as the sidebar reads it (FR-BOSS-009, AC27 to AC30, AC44 to AC47, #2070,
// #2093): where the sidebar stands for him, how far it comes out, and the bounce (or, under reduced motion, the fade)
// it plays as it comes out. The rules are brokk-edge-model.ts's.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { BossBubbleModel } from "./boss-store";
import {
    edgeMotionOf,
    EdgeShape,
    edgeShapeOf,
    newsToTell,
    Played,
    playEdgeMotion,
    SidebarPlace,
} from "./brokk-edge-model";
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
    // A tell is a request to come out for news; it lasts until its motion ends.
    const [tell, setTell] = useState(0);
    const [telling, setTelling] = useState(false);
    const played = useRef(bounce);
    const startedTell = useRef(0);
    const playing = useRef<Played>(null);
    const shapeBefore = useRef<EdgeShape>(null);
    // Looking at the badge is being able to: the sidebar is on screen, or his group is open.
    const looking = place !== "edge" || cardOpen;
    const coming = useHubSelect((view) => view.comingKeys);
    const keysKey = keys.join("\n");
    const comingKey = coming.join("\n");
    const held = useHubSelect((view) => view.heldKeys);
    const heldKey = held.join("\n");
    const shape = edgeShapeOf(place, { visit, cue, telling });

    useEffect(
        () => edgeModel.tell(keys, looking, ready, coming, held),
        [edgeModel, keysKey, comingKey, heldKey, looking, ready]
    );
    useEffect(() => {
        const step = newsToTell(bounce, played.current, place);
        played.current = step.played;
        if (step.tell) {
            setTelling(true);
            setTell((n) => n + 1);
        }
        // Only a new bounce count tells: a change of place alone must not replay an old one.
    }, [bounce]);
    useEffect(() => {
        const before = shapeBefore.current;
        shapeBefore.current = shape;
        if (shape == null || shape === "rest") {
            playing.current?.cancel();
            playing.current = null;
            if (shape == null) {
                setTelling(false);
            }
            return;
        }
        const tellStarts = tell !== startedTell.current;
        startedTell.current = tell;
        const motion = edgeMotionOf(before, shape, tellStarts, prefersReducedMotion());
        if (motion == null) {
            if (tellStarts) {
                setTelling(false);
            }
            return;
        }
        playing.current?.cancel();
        playing.current = playEdgeMotion(asideRef.current, motion, () => setTelling(false));
    }, [shape, tell, asideRef]);

    return { place, shape };
}
