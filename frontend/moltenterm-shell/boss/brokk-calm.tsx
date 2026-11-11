// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's face under reduced motion (FR-BOSS-009, AC1, #2224): the loop of his pose and, now and then, a slow blink, which
// is all that moves. The blink clip lies over the loop for one round, started where the loop comes round so that the two
// are in step and end together (brokk-calm-model.ts). A change of pose swaps the loop, with no clip between the two.
// Whatever cannot play leaves what is under it: the still of boss-portrait.tsx, or the `poster`.

import { useRef, useState } from "react";
import type { BrokkPose } from "./brokk-ask-model";
import { blinkClipOf, calmAfter, hasBlink, loopClipOf, startCalm } from "./brokk-calm-model";
import "./brokk-calm.css";

// The clips as URLs only, read by the player's videos.
const Clips = import.meta.glob("./portrait/brokk/*.webm", {
    query: "?url",
    import: "default",
    eager: true,
}) as unknown as Record<string, string>;

function clipUrl(name: string): string {
    return Clips[`./portrait/brokk/${name}.webm`];
}

export function BrokkCalm({ pose, poster }: { pose: BrokkPose; poster?: string }) {
    // A new pose is a new player: its loop starts from its first frame and its blinks from a new wait.
    return <CalmPlayer key={pose} pose={pose} poster={poster} />;
}

function CalmPlayer({ pose, poster }: { pose: BrokkPose; poster?: string }) {
    const loopRef = useRef<HTMLVideoElement>(null);
    const blinkRef = useRef<HTMLVideoElement>(null);
    const calm = useRef(startCalm(Date.now(), Math.random()));
    const [blinking, setBlinking] = useState(false);
    const blinkUrl = hasBlink(pose) ? clipUrl(blinkClipOf(pose)) : null;

    const onTime = () => {
        const loop = loopRef.current;
        const blink = blinkRef.current;
        if (loop == null || blink == null) {
            return;
        }
        const step = calmAfter(calm.current, {
            type: "time",
            at: Date.now(),
            currentTime: loop.currentTime,
            random: Math.random(),
        });
        calm.current = step.state;
        if (!step.blink) {
            return;
        }
        blink.currentTime = loop.currentTime;
        blink.play().then(
            () => setBlinking(true),
            () => {
                calm.current = calmAfter(calm.current, { type: "blink-failed" }).state;
            }
        );
    };
    const onBlinkEnded = () => {
        calm.current = calmAfter(calm.current, { type: "blink-ended" }).state;
        setBlinking(false);
    };
    const onBlinkError = () => {
        calm.current = calmAfter(calm.current, { type: "blink-failed" }).state;
        setBlinking(false);
    };

    return (
        <span className="mt-brokk-calm" data-pose={pose} data-testid="brokk-calm">
            <video
                ref={loopRef}
                className="mt-brokk-calm-video"
                src={clipUrl(loopClipOf(pose))}
                poster={poster}
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
                onTimeUpdate={blinkUrl != null ? onTime : undefined}
            />
            {blinkUrl != null ? (
                <video
                    ref={blinkRef}
                    className="mt-brokk-calm-video mt-brokk-calm-blink"
                    data-on={blinking ? "true" : "false"}
                    src={blinkUrl}
                    muted
                    playsInline
                    preload="auto"
                    onEnded={onBlinkEnded}
                    onError={onBlinkError}
                />
            ) : null}
        </span>
    );
}
