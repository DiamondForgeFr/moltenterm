// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Brokk shows and when his animated portrait is asked for (FR-BOSS-007, AC3 to AC5 and AC10 to AC16). The scene
// (brokk-scene.ts) is read once per surface, from the rows To handle, the agents, his mood and the clock, and every
// surface draws what it gives. The portrait is asked for by each surface that shows his face: the card's header, which
// plays while the card shows, and the avatar, which plays its calm loop at rest (use-brokk-hub.ts). Nothing plays under
// reduced motion (the app's setting or the system's), in a window nobody sees or in a tab view that is not on screen
// (faceVisibleIn): those surfaces show the still, and mount no video. What is returned for the portrait is what
// BossPortrait hands to the lazy portrait (brokk-live.tsx), or null for the still alone.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { prefersReducedMotion } from "../molten-motion";
import { TabActivity } from "../tab-activity";
import { ActivityState, isShowing } from "../tab-activity-model";
import { BossPeek } from "./boss-overview";
import { BossBubbleModel } from "./boss-store";
import { toHandleHeadline } from "./boss-to-handle-model";
import { BrokkSituation, speaksOnOpen } from "./brokk-ask-model";
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

// The clips play unless the developer asked for less motion or nobody can see them.
export function useMotionAllowed(): boolean {
    const visible = useFaceVisible();
    return visible && !prefersReducedMotion();
}

// `watchAway`: a surface shows his face, so whether the developer is away is read (developer-away.ts).
export function useBrokkSituation(
    cardOpen: boolean,
    watchAway: boolean,
    talk?: BrokkSituation["talk"]
): BrokkSituation {
    const model = BossBubbleModel.getInstance();
    const working = useAtomValue(model.workingCountAtom, { store: globalStore });
    const badge = useAtomValue(model.badgeAtom, { store: globalStore });
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

// The panel's portrait plays while the panel shows: the avatar that opened it has emptied its face, so there is one
// animated Brokk at a time (FR-BOSS-007, AC8). `talk`: what the field is doing (brokk-talk-model.ts talkPose).
export function useCardLive(talk?: BrokkSituation["talk"]): BrokkLiveProps {
    const asked = useAtomValue(BrokkExpressionsModel.getInstance().askedAtom, { store: globalStore });
    const allowed = useMotionAllowed();
    const situation = useBrokkSituation(true, allowed, talk);
    return useMemo(
        () => (allowed ? { situation, asked, speaks: speaksOnOpen(situation), rhythm: "normal" } : null),
        [allowed, situation, asked]
    );
}
