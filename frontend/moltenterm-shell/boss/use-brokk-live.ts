// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// When Brokk's animated portrait is asked for (FR-BOSS-007, AC3 to AC5), by each surface that shows his face: the
// bubble, whose round plays one gesture, the call, when the count rises and whose open comm screen plays the loop of
// his pose; and the card's header, which plays while the card shows. Nothing plays under reduced motion (the app's
// setting or the system's) or while the window is hidden: those surfaces show the still. What is returned is what
// BossPortrait hands to the lazy portrait (brokk-live.tsx), or null for the still alone.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { BossBubbleModel } from "./boss-store";
import { BrokkSituation, callPending, handledAfter, speaksOnOpen } from "./brokk-ask-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import type { BrokkLiveProps } from "./brokk-live";
import { useDeveloperAway } from "./developer-away";

// True while the window is on screen: a hidden window plays nothing, and its portrait draws anew when it comes back.
export function usePageVisible(): boolean {
    const [visible, setVisible] = useState(() => globalThis.document?.visibilityState !== "hidden");
    useEffect(() => {
        const onChange = () => setVisible(document.visibilityState !== "hidden");
        onChange();
        document.addEventListener("visibilitychange", onChange);
        return () => document.removeEventListener("visibilitychange", onChange);
    }, []);
    return visible;
}

// The clips play unless the developer asked for less motion or nobody can see them.
export function useMotionAllowed(): boolean {
    const visible = usePageVisible();
    return visible && !prefersReducedMotion();
}

// `watchAway`: a surface shows his face, so whether the developer is away is read (developer-away.ts).
export function useBrokkSituation(cardOpen: boolean, watchAway: boolean): BrokkSituation {
    const model = BossBubbleModel.getInstance();
    const working = useAtomValue(model.workingCountAtom, { store: globalStore });
    const badge = useAtomValue(model.badgeAtom, { store: globalStore });
    const away = useDeveloperAway(watchAway);
    return useMemo(() => ({ working, waiting: badge.count, cardOpen, away }), [working, badge.count, cardOpen, away]);
}

// He speaks for a few seconds when the card opens on items to handle (AC2): the count at the opening decides, not one
// that rises while the card shows. The comm screen may already be open (the hover) when the card opens, so this is a
// change of its props, not only a reading at its mount.
export function useSpeaksOnOpen(situation: BrokkSituation): boolean {
    const [speaks, setSpeaks] = useState(() => situation.cardOpen && speaksOnOpen(situation));
    const waiting = useRef(situation.waiting);
    waiting.current = situation.waiting;
    useEffect(() => {
        setSpeaks(situation.cardOpen && speaksOnOpen({ ...situation, waiting: waiting.current }));
    }, [situation.cardOpen]);
    return speaks;
}

export function useBubbleLive(options: {
    collapsed: boolean;
    screenOpen: boolean;
    situation: BrokkSituation;
}): BrokkLiveProps {
    const { collapsed, screenOpen, situation } = options;
    const asked = useAtomValue(BrokkExpressionsModel.getInstance().askedAtom, { store: globalStore });
    const allowed = useMotionAllowed();
    const speaks = useSpeaksOnOpen(situation);
    // The newest cue the round has played, or has no use for: a call asked while the bubble was folded, the window hidden
    // or the screen open (which plays it itself) is not played later.
    const [handled, setHandled] = useState(asked?.cue ?? 0);
    const consumed = collapsed || !allowed || screenOpen;
    useEffect(() => {
        const next = handledAfter(handled, asked, consumed);
        if (next !== handled) {
            setHandled(next);
        }
    }, [consumed, asked, handled]);
    const calling = callPending(asked, handled, consumed);
    const cue = asked?.cue ?? 0;
    const onPlayed = useCallback(() => setHandled((seen) => Math.max(seen, cue)), [cue]);

    return useMemo(() => {
        if (collapsed || !allowed || !(screenOpen || calling)) {
            return null;
        }
        return { situation, asked, play: calling ? asked : undefined, speaks: screenOpen && speaks, onPlayed };
    }, [collapsed, allowed, screenOpen, calling, situation, asked, speaks, onPlayed]);
}

export function useCardLive(): BrokkLiveProps {
    const asked = useAtomValue(BrokkExpressionsModel.getInstance().askedAtom, { store: globalStore });
    const allowed = useMotionAllowed();
    const situation = useBrokkSituation(true, allowed);
    return useMemo(
        () => (allowed ? { situation, asked, speaks: speaksOnOpen(situation) } : null),
        [allowed, situation, asked]
    );
}
