// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Brokk shows and when his animated portrait is asked for (FR-BOSS-007, AC3 to AC5 and AC10 to AC16). The scene
// (brokk-scene.ts) is read from the rows To handle, the agents, his mood and the clock, and the faces draw what they need
// of it: today the rhythm of their blinks (useBlinkRhythm). The portrait is asked for by each surface that shows his face:
// the card's header, which plays while the card shows, and the avatar, which plays at rest (use-brokk-hub.ts). Nothing
// plays in a window nobody sees or in a tab view that is not on screen (faceVisibleIn): those surfaces show the still, and
// mount no video. Under reduced motion (the app's setting or the system's, read from its atom) the face is still
// asked for, as a calm loop: no gesture asked, `calm` set (brokk-calm.tsx, #2224). What is returned for the portrait is
// what BossPortrait hands to the lazy portrait (brokk-live.tsx), or null for the still alone.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentStatesData } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { TabActivity } from "../tab-activity";
import { ActivityState, isShowing } from "../tab-activity-model";
import { BossBubbleModel } from "./boss-store";
import { BrokkSituation, speaksOnOpen } from "./brokk-ask-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkHubModel } from "./brokk-hub-store";
import type { BrokkLiveProps } from "./brokk-live";
import { BlinkRhythm, BrokkScene, brokkScene } from "./brokk-scene";
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

// Whether his face can be seen: the page is visible and this tab view is on screen in a window that shows (it need not
// have the focus: a face beside the terminal the developer types in stays animated). Where it cannot be seen nothing is
// mounted, so nothing plays or decodes there (#2154).
export function faceVisibleIn(pageVisible: boolean, activity: ActivityState): boolean {
    return pageVisible && isShowing(activity);
}

export function useFaceVisible(): boolean {
    const pageVisible = usePageVisible();
    const activity = useAtomValue(TabActivity.getInstance().stateAtom, { store: globalStore });
    return faceVisibleIn(pageVisible, activity);
}

// Less motion, asked for by the system or by the app's own setting. Read from its atom, so that a change reaches every
// face at once instead of at their next draw (#2224).
export function useReducedMotion(): boolean {
    return useAtomValue(atoms.prefersReducedMotionAtom, { store: globalStore });
}

// The whole of his motion (gestures, clips between poses) plays unless the developer asked for less or nobody can see him.
// Under less motion a face that can be seen still plays a calm loop (brokk-calm.tsx).
export function useMotionAllowed(): boolean {
    const visible = useFaceVisible();
    const reduced = useReducedMotion();
    return visible && !reduced;
}

// `watchAway`: a surface shows his face, so whether the developer is away is read (developer-away.ts).
export function useBrokkSituation(
    cardOpen: boolean,
    watchAway: boolean,
    talk?: BrokkSituation["talk"]
): BrokkSituation {
    const model = BossBubbleModel.getInstance();
    const working = useAtomValue(model.workingCountAtom, { store: globalStore });
    // The face's count, the one the avatar shows (#2223).
    const badge = useAtomValue(BrokkHubModel.getInstance().faceBadgeAtom, { store: globalStore });
    const away = useDeveloperAway(watchAway);
    return useMemo(
        () => ({ working, waiting: badge.count, cardOpen, away, talk }),
        [working, badge.count, cardOpen, away, talk]
    );
}

// The longest a timer is set for: setTimeout overflows beyond it.
const MaxTimerMs = 2 ** 31 - 1;

export type BrokkSceneOptions = {
    // The comm screen stands beside the open card (the bubble is not folded): the card's header shows the still.
    pinned: boolean;
    situation: BrokkSituation;
    speaks: boolean;
};

// The scene the bubble draws now, read once: it changes with the rows, the agents, the mood and the clock, and it is
// drawn again by itself when a wait crosses a limit or the night begins or ends.
export function useBrokkScene(options: BrokkSceneOptions): BrokkScene {
    const { pinned, situation, speaks } = options;
    const model = BossBubbleModel.getInstance();
    const expressions = BrokkExpressionsModel.getInstance();
    const badge = useAtomValue(BrokkHubModel.getInstance().faceBadgeAtom, { store: globalStore });
    const toHandle = useAtomValue(model.toHandleAtom, { store: globalStore });
    const memory = useAtomValue(expressions.moodAtom, { store: globalStore });
    const asked = useAtomValue(expressions.askedAtom, { store: globalStore });
    const lastKeyAt = useAtomValue(expressions.lastKeyAtAtom, { store: globalStore });
    const agents = useAtomValue(AgentStates.getInstance().dataAtom, { store: globalStore });
    const motion = useMotionAllowed();
    const [, redraw] = useState(0);
    const now = Date.now();

    const scene = brokkScene({
        situation,
        now,
        memory,
        facts: moodFactsOf(unseenItems(toHandle)),
        badge,
        asked,
        speaking: speaks,
        motion,
        pinned,
        lastKeyAt,
        workingSince: oldestWorkingSince(agents),
    });

    useEffect(() => {
        const wait = Math.min(Math.max(scene.until - Date.now(), 0) + 1, MaxTimerMs);
        const timer = setTimeout(() => redraw((n) => n + 1), wait);
        return () => clearTimeout(timer);
    }, [scene.until]);
    return scene;
}

function oldestWorkingSince(agents: AgentStatesData): number {
    return Object.values(agents?.states ?? {})
        .filter((info) => info?.state === "working" && info.since > 0)
        .reduce((oldest, info) => (oldest === 0 || info.since < oldest ? info.since : oldest), 0);
}

function sceneFromStores(situation: BrokkSituation, now: number): BrokkScene {
    const model = BossBubbleModel.getInstance();
    const expressions = BrokkExpressionsModel.getInstance();
    return brokkScene({
        situation,
        now,
        memory: globalStore.get(expressions.moodAtom),
        facts: moodFactsOf(unseenItems(globalStore.get(model.toHandleAtom))),
        badge: globalStore.get(BrokkHubModel.getInstance().faceBadgeAtom),
        asked: globalStore.get(expressions.askedAtom),
        speaking: false,
        motion: true,
        pinned: false,
        lastKeyAt: globalStore.get(expressions.lastKeyAtAtom),
        workingSince: oldestWorkingSince(globalStore.get(AgentStates.getInstance().dataAtom)),
    });
}

// How the scene wants his blinks spaced for this situation: calmer late at night, while the developer types and after a
// long thought (FR-BOSS-007, AC17, #2010; FR-BOSS-009, AC1, #2219). Every face that blinks asks it here. It reads the
// stores itself and is drawn again only when the rhythm changes, not when a keystroke or an agent's state does: the
// avatar and the open group must not draw again for each of those.
export function useBlinkRhythm(situation: BrokkSituation): BlinkRhythm {
    const latest = useRef(situation);
    latest.current = situation;
    const subscribe = useCallback((notify: () => void) => {
        const model = BossBubbleModel.getInstance();
        const expressions = BrokkExpressionsModel.getInstance();
        let timer: ReturnType<typeof setTimeout> = null;
        const arm = () => {
            clearTimeout(timer);
            const scene = sceneFromStores(latest.current, Date.now());
            const wait = Math.min(Math.max(scene.until - Date.now(), 0) + 1, MaxTimerMs);
            timer = setTimeout(() => {
                notify();
                arm();
            }, wait);
        };
        const onChange = () => {
            notify();
            arm();
        };
        arm();
        const stops = [
            expressions.moodAtom,
            expressions.lastKeyAtAtom,
            model.toHandleAtom,
            AgentStates.getInstance().dataAtom,
        ].map((source) => globalStore.sub(source, onChange));
        return () => {
            clearTimeout(timer);
            stops.forEach((stop) => stop());
        };
    }, []);
    const read = () => sceneFromStores(situation, Date.now()).rhythm;
    return useSyncExternalStore(subscribe, read, read);
}

// The panel's portrait plays while the panel shows: the avatar that opened it has emptied its face, so there is one
// animated Brokk at a time (FR-BOSS-007, AC8). `talk`: what the conversation is doing (brokk-speech-model.ts talkFace).
export function useCardLive(talk?: BrokkSituation["talk"]): BrokkLiveProps {
    const asked = useAtomValue(BrokkExpressionsModel.getInstance().askedAtom, { store: globalStore });
    const visible = useFaceVisible();
    const calm = useReducedMotion();
    const situation = useBrokkSituation(true, visible, talk);
    const rhythm = useBlinkRhythm(situation);
    return useMemo(
        () => (visible ? { situation, asked, speaks: speaksOnOpen(situation), rhythm, calm } : null),
        [visible, calm, situation, asked, rhythm]
    );
}
