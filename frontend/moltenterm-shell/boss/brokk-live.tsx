// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk alive (FR-BOSS-007, AC1 to AC5): the shared character package's portrait, drawn over his still in the frame
// every surface shares (boss-portrait.tsx). It loads on its own, the first time a surface asks for it, so that the
// package and its clips are read by nobody before. The package plays the clips (the loop of the pose, the clips between
// two poses, the gestures); this component hands it the pose MoltenTerm's signals give (brokk-state-model.ts) and the
// gesture the app asks. The package is asked for the picture alone (`bare`): the screen furniture is the bubble's own
// (boss-screen.tsx). Whatever fails to load or to play leaves the still showing.

import { TransmissionPortrait } from "@diamondforge/character";
import "@diamondforge/character/styles.css";
import { useEffect, useReducer } from "react";
import type { AskedExpression, BrokkSituation } from "./brokk-ask-model";
import "./brokk-live.css";
import { startMoments } from "./brokk-moments";
import { BrokkPortrait } from "./brokk-portrait";
import { brokkPose, faceAfter, reactionCapMs, SpeakingMs, startFace } from "./brokk-state-model";

export type BrokkLiveProps = {
    situation: BrokkSituation;
    // The newest gesture the app asked. One asked before this mounted is not played: it was told to a surface that was
    // not showing.
    asked: AskedExpression;
    // A gesture to play at once, the one that put this on screen (the call in the round).
    play?: AskedExpression;
    // He speaks for a moment: the card has just opened on items to handle.
    speaks?: boolean;
    // The gesture asked at the mount has ended.
    onPlayed?: () => void;
};

export function BrokkLive({ situation, asked, play, speaks, onPlayed }: BrokkLiveProps) {
    const [face, dispatch] = useReducer(faceAfter, { asked, play, speaks }, startFace);
    const reaction = face.reaction;

    useEffect(() => startMoments(), []);
    useEffect(() => {
        if (asked != null) {
            dispatch({ type: "asked", asked });
        }
    }, [asked]);
    useEffect(() => {
        if (!face.speaking) {
            return;
        }
        const timer = setTimeout(() => dispatch({ type: "speech-expired" }), SpeakingMs);
        return () => clearTimeout(timer);
    }, [face.speaking]);
    useEffect(() => {
        if (reaction == null) {
            return;
        }
        const timer = setTimeout(
            () => dispatch({ type: "reaction-expired", cue: reaction.cue }),
            reactionCapMs(reaction.expression)
        );
        return () => clearTimeout(timer);
    }, [reaction]);
    useEffect(() => {
        if (play != null && reaction == null) {
            onPlayed?.();
        }
    }, [play, reaction]);

    const pose = brokkPose(situation, { speaking: face.speaking, expression: reaction?.expression ?? null });

    // `ended` does not bubble: React hears it in the capture phase, so the end of a gesture's clip, wherever the package
    // lays that clip, hands the pose back.
    const onEnded = (e: React.SyntheticEvent) => {
        const base = (e.target as Element).getAttribute?.("data-video");
        if (base) {
            dispatch({ type: "clip-ended", base });
        }
    };

    return (
        <div className="mt-brokk-live" data-pose={pose} data-testid="brokk-live" onEndedCapture={onEnded}>
            <TransmissionPortrait
                {...BrokkPortrait}
                bare
                className="mt-brokk-portrait"
                alt=""
                state={pose}
                expression={reaction}
            />
        </div>
    );
}
