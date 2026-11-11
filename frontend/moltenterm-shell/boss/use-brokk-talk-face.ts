// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What his face does with the conversation, for his group's square (FR-BOSS-009, AC86, AC87, #2259): it says his answers
// while the group shows (brokk-speech.ts), and gives the pose talkFace reads, drawn again by itself when a silence
// turns into thinking.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { BrokkSituation } from "./brokk-ask-model";
import { BrokkSpeech } from "./brokk-speech";
import { talkFace } from "./brokk-speech-model";

export type TalkFaceSignals = {
    // The developer has text in the field.
    typing: boolean;
    // A message is on its way, or his agent has it and his answer is not complete (brokk-talk-model.ts talkWaits).
    awaiting: boolean;
    // His own session works (the ring turns).
    working: boolean;
};

export function useTalkFace(signals: TalkFaceSignals): BrokkSituation["talk"] {
    const speech = BrokkSpeech.getInstance();
    useEffect(() => speech.watch(), [speech]);
    const speaking = useAtomValue(speech.speakingAtom, { store: globalStore });
    const busy = signals.awaiting || signals.working;
    const quiet = busy && !speaking;
    // Since when he has been busy and silent: read at the draw that saw it start.
    const quietSince = useRef<number>(null);
    if (!quiet) {
        quietSince.current = null;
    } else if (quietSince.current == null) {
        quietSince.current = Date.now();
    }
    const [, redraw] = useState(0);
    const face = talkFace({
        typing: signals.typing,
        busy,
        speaking,
        quietSince: quietSince.current,
        now: Date.now(),
    });
    useEffect(() => {
        if (face.wakeAt == null) {
            return;
        }
        const timer = setTimeout(() => redraw((n) => n + 1), Math.max(face.wakeAt - Date.now(), 0) + 1);
        return () => clearTimeout(timer);
    }, [face.wakeAt]);
    return face.talk;
}
