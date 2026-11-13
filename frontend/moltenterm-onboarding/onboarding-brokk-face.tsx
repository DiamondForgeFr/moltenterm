// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's face on the first launch's scene (FR-ONB-007 B-2, B-4, DS-ONB-007, #2304): his animated portrait, the one his
// group's square draws (BossPortrait and its live props), speaking for a moment as the scene arrives, then listening with
// his idles; under reduced motion his calm loop. While it is on screen it lends his face, so the sidebar's avatar wears his
// initial: one animated Brokk on screen (FR-BOSS-007 AC8). When the developer opens his group from there, the group's
// square is the animated one and this frame wears his initial in turn. Kept out of the pour's stage, which renders without
// a window: onboarding-view.tsx hands it to the scene.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { BossPortrait } from "../moltenterm-shell/boss/boss-portrait";
import { BossBubbleModel } from "../moltenterm-shell/boss/boss-store";
import { SpeakingMs, type BrokkPose } from "../moltenterm-shell/boss/brokk-ask-model";
import { useBrokkVisitUp } from "../moltenterm-shell/boss/use-brokk-hub";
import { useCardLive } from "../moltenterm-shell/boss/use-brokk-live";
import { BrokkIntroMark } from "./onboarding-pour-brokk";

// He looks up at the developer (the situation of an open card), and speaks or listens: the portrait is declared with these
// two poses only, so it mounts fewer clips.
export const IntroPoses: readonly BrokkPose[] = ["listening", "speaking"];

export function OnboardingBrokkFace() {
    const boss = BossBubbleModel.getInstance();
    const name = useAtomValue(boss.nameAtom, { store: globalStore });
    const cardOpen = useAtomValue(boss.cardOpenAtom, { store: globalStore });
    // His visit stands in the sidebar with his face: it is the animated one while it is up.
    const visitUp = useBrokkVisitUp();
    const [speaking, setSpeaking] = useState(true);
    const card = useCardLive(speaking ? "answering" : undefined);
    const elsewhere = cardOpen || visitUp;

    useEffect(() => {
        const timer = setTimeout(() => setSpeaking(false), SpeakingMs);
        return () => clearTimeout(timer);
    }, []);
    useEffect(() => {
        if (elsewhere) {
            return;
        }
        return boss.lendFace();
    }, [boss, elsewhere]);

    const live = useMemo(() => (card == null ? null : { ...card, poses: IntroPoses }), [card]);
    if (elsewhere) {
        return <BrokkIntroMark name={name} />;
    }
    return <BossPortrait live={live} />;
}
