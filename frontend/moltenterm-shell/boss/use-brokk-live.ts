// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Brokk shows and when his animated portrait is asked for (FR-BOSS-007, AC3 to AC5 and AC10 to AC16). The scene
// (brokk-scene.ts) is read once per bubble, from the rows To handle, the agents, his mood and the clock, and every
// surface draws what it gives. The portrait is asked for by each surface that shows his face: the bubble, whose round
// plays one gesture, the call, when the badge rises and whose open comm screen plays the loop of his pose; and the card's
// header, which plays while the card shows and no screen stands beside it. Nothing plays under reduced motion (the
// app's setting or the system's) or while the window is hidden: those surfaces show the still. What is returned for the
// portrait is what BossPortrait hands to the lazy portrait (brokk-live.tsx), or null for the still alone.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { prefersReducedMotion } from "../molten-motion";
import { BossPeek } from "./boss-overview";
import { BossBubbleModel } from "./boss-store";
import { toHandleHeadline } from "./boss-to-handle-model";
import { BrokkSituation, callPending, handledAfter, SpeakingMs, speaksOnOpen } from "./brokk-ask-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import type { BrokkLiveProps } from "./brokk-live";
import { BrokkScene, brokkScene, CaptionLine } from "./brokk-scene";
import { moodFactsOf, unseenItems } from "./brokk-watch";
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
// change of its props, not only a reading at its mount. The caption says his sentence for as long as he speaks.
export function useSpeaksOnOpen(situation: BrokkSituation): boolean {
    const [speaks, setSpeaks] = useState(() => situation.cardOpen && speaksOnOpen(situation));
    const waiting = useRef(situation.waiting);
    waiting.current = situation.waiting;
    useEffect(() => {
        setSpeaks(situation.cardOpen && speaksOnOpen({ ...situation, waiting: waiting.current }));
    }, [situation.cardOpen]);
    useEffect(() => {
        if (!speaks) {
            return;
        }
        const timer = setTimeout(() => setSpeaks(false), SpeakingMs);
        return () => clearTimeout(timer);
    }, [speaks]);
    return speaks;
}

// The longest a timer is set for: setTimeout overflows beyond it.
const MaxTimerMs = 2 ** 31 - 1;

export type BrokkSceneOptions = {
    // The comm screen stands beside the open card (the bubble is not folded): the card's header shows the still.
    pinned: boolean;
    peek: BossPeek;
    situation: BrokkSituation;
    speaks: boolean;
};

// The scene the bubble draws now, read once: it changes with the rows, the agents, the mood and the clock, and it is
// drawn again by itself when a mention runs out or a wait crosses a limit.
export function useBrokkScene(options: BrokkSceneOptions): BrokkScene {
    const { pinned, peek, situation, speaks } = options;
    const model = BossBubbleModel.getInstance();
    const expressions = BrokkExpressionsModel.getInstance();
    const badge = useAtomValue(model.badgeAtom, { store: globalStore });
    const toHandle = useAtomValue(model.toHandleAtom, { store: globalStore });
    const memory = useAtomValue(expressions.moodAtom, { store: globalStore });
    const asked = useAtomValue(expressions.askedAtom, { store: globalStore });
    const lastKeyAt = useAtomValue(expressions.lastKeyAtAtom, { store: globalStore });
    const agents = useAtomValue(AgentStates.getInstance().dataAtom, { store: globalStore });
    const motion = useMotionAllowed();
    const [, redraw] = useState(0);
    const now = Date.now();

    const items = unseenItems(toHandle);
    const top: CaptionLine = items.length > 0 ? { text: toHandleHeadline(items[0]) } : null;
    const worker = situation.working === 1 ? (peek.working[0]?.names[0] ?? "") : "";
    const usage = peek.usage.find((line) => line.level !== "normal");
    const workingSince = Object.values(agents?.states ?? {})
        .filter((info) => info?.state === "working" && info.since > 0)
        .reduce((oldest, info) => (oldest === 0 || info.since < oldest ? info.since : oldest), 0);
    const scene = brokkScene({
        situation,
        now,
        memory,
        facts: moodFactsOf(items, toHandleHeadline),
        top,
        worker,
        badge,
        asked,
        speaking: speaks,
        motion,
        pinned,
        lastKeyAt,
        workingSince,
        usage: usage
            ? { key: "boss.peek.usage", vars: { agent: usage.agent, label: usage.label, used: usage.percent } }
            : null,
    });

    useEffect(() => {
        const wait = Math.min(Math.max(scene.until - Date.now(), 0) + 1, MaxTimerMs);
        const timer = setTimeout(() => redraw((n) => n + 1), wait);
        return () => clearTimeout(timer);
    }, [scene.until]);
    return scene;
}

export function useBubbleLive(options: {
    collapsed: boolean;
    screenOpen: boolean;
    situation: BrokkSituation;
    speaks: boolean;
    rhythm: BrokkScene["rhythm"];
}): BrokkLiveProps {
    const { collapsed, screenOpen, situation, speaks, rhythm } = options;
    const asked = useAtomValue(BrokkExpressionsModel.getInstance().askedAtom, { store: globalStore });
    const allowed = useMotionAllowed();
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
    const onOpened = useCallback(() => BrokkExpressionsModel.getInstance().noteOpen(), []);

    return useMemo(() => {
        if (collapsed || !allowed || !(screenOpen || calling)) {
            return null;
        }
        return {
            situation,
            asked,
            play: calling ? asked : undefined,
            speaks: screenOpen && speaks,
            onPlayed,
            opened: screenOpen,
            onOpened,
            rhythm,
        };
    }, [collapsed, allowed, screenOpen, calling, situation, asked, speaks, onPlayed, onOpened, rhythm]);
}

// The card's header plays while the card shows, unless the comm screen stands beside it (`still`, from the scene): one
// animated Brokk at a time (AC8).
export function useCardLive(still: boolean): BrokkLiveProps {
    const asked = useAtomValue(BrokkExpressionsModel.getInstance().askedAtom, { store: globalStore });
    const allowed = useMotionAllowed();
    const situation = useBrokkSituation(true, allowed && !still);
    return useMemo(
        () => (allowed && !still ? { situation, asked, speaks: speaksOnOpen(situation), rhythm: "normal" } : null),
        [allowed, still, situation, asked]
    );
}
