// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one line Brokk says under his square (FR-BOSS-009, AC17, #2032): the caption of his scene (brokk-scene.ts). It is
// read from the same situation, mood and watch as his pose (use-brokk-live.ts), so the words under the square always match
// the face above them: what he says now, what the developer just did, a failure, its relief, a long wait, what waits, the
// news of a moment ago, what works, and nothing going on. The hover card of his avatar says the same.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { BossBubbleModel } from "./boss-store";
import { BrokkSituation, speaksOnOpen } from "./brokk-ask-model";
import { useCaptionText } from "./brokk-caption";
import { useBrokkScene, useBrokkSituation, useMotionAllowed } from "./use-brokk-live";

// `talk`: what the field is doing (brokk-talk-model.ts talkPose), the same the portrait is given.
export function useGroupCaption(talk?: BrokkSituation["talk"]): string {
    const peek = useAtomValue(BossBubbleModel.getInstance().peekAtom, { store: globalStore });
    const allowed = useMotionAllowed();
    const situation = useBrokkSituation(true, allowed, talk);
    const scene = useBrokkScene({ pinned: false, peek, situation, speaks: speaksOnOpen(situation) });
    const text = useCaptionText();
    const { status, detail } = scene.caption;
    return [text(status), detail != null ? text(detail) : ""].filter((part) => part !== "").join(" ");
}
