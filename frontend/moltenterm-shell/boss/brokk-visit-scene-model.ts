// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the visit scene says and does (FR-BOSS-009, AC6, AC7, #2002), apart from how it is drawn: the words of its
// accessible name, the delays of its Plus tard menu, the clip of each face, what a key or a click on it means, and how
// long each movement lasts. The movements' durations here are the CSS's (brokk-visit-scene.css reads them from the
// custom properties the scene sets), so that the timer that unmounts the scene after it left is the animation's own.
// Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { BrokkExpression } from "./brokk-ask-model";
import { Severity, SeverityExpression } from "./brokk-queue";
import { SnoozeChoiceId, snoozeChoices } from "./brokk-visit";

// The scene grows out of the avatar, and the content below the title row makes room for it by this much (the mockup's
// 84 px under a 36 px title row): the scene's bottom is 8 px above the search field.
export const SceneRoomPx = 84;
// The bottom of the scene fades into the sidebar's own background over this height.
export const SceneFadePx = 60;
// The gap between the scene's bottom and the search field.
export const SceneGapPx = 8;

export type SceneTimings = {
    // The scene grows out of the avatar.
    openMs: number;
    // The content below the title row slides down.
    slideDownMs: number;
    // Everything goes back: the scene folds into the avatar and the content slides up.
    closeMs: number;
    // The scene cross-fades under reduced motion; the content then changes place at once.
    fadeMs: number;
};

export const MotionTimings: SceneTimings = { openMs: 360, slideDownMs: 320, closeMs: 300, fadeMs: 150 };

// What the CSS plays: under reduced motion the scene cross-fades and nothing moves.
export function sceneTimings(reduced: boolean): SceneTimings {
    return reduced
        ? { openMs: MotionTimings.fadeMs, slideDownMs: 0, closeMs: MotionTimings.fadeMs, fadeMs: MotionTimings.fadeMs }
        : MotionTimings;
}

// Long enough for the scene to be gone before it is unmounted.
export function unmountAfterMs(reduced: boolean): number {
    const timings = sceneTimings(reduced);
    return Math.max(timings.closeMs, timings.slideDownMs) + 40;
}

// Where the scene is in its life: "pre" the frame after it is mounted, drawn at the avatar's size to grow from; "open"
// while the visit is up; "closing" from the moment it is not until it is unmounted.
export type ScenePhase = "pre" | "open" | "closing";

export function scenePhase(visitUp: boolean, drawnOpen: boolean): ScenePhase {
    if (!visitUp) {
        return "closing";
    }
    return drawnOpen ? "open" : "pre";
}

export const SeverityLabelKeys: Record<Severity, string> = {
    grave: "boss.visit.severity.grave",
    important: "boss.visit.severity.important",
    neutre: "boss.visit.severity.neutre",
    bonne: "boss.visit.severity.bonne",
};

// His accessible name, which is also the tooltip: the scene has no text, so this is all it says. The example says so.
export function sceneLabel(
    t: (key: string, vars?: Record<string, any>) => string,
    name: string,
    severity: Severity,
    example: boolean = false
): string {
    const key = example ? "boss.visit.example" : "boss.visit.label";
    return t(key, { name, severity: t(SeverityLabelKeys[severity]) });
}

// The clips of the package's listening pose he makes each face with.
export const SceneClipNames: Record<BrokkExpression, string> = {
    frown: "listening.frown",
    doubtful: "listening.doubtful",
    call: "listening.call",
    smile: "listening.smile",
    nod: "listening.nod",
    sigh: "listening.sigh",
    proud: "listening.proud",
    chuckle: "listening.chuckle",
    surprised: "listening.surprised",
};

export function sceneClipOf(severity: Severity): string {
    return SceneClipNames[SeverityExpression[severity]];
}

// The gesture of the severity, which his living portrait plays once in the listening pose, as he arrives.
export function sceneGestureOf(severity: Severity): BrokkExpression {
    return SeverityExpression[severity];
}

// What he does now and then while he waits, besides the idles the package draws by chance (#2262): only a grave visit
// has such a gesture, his sigh, and nothing else ever plays the sigh. The face of the severity no longer comes back: it
// came back every 20 to 40 s for want of anything else to do (#2025), and the waiting idles took its place.
export const SceneWaitGestures: Partial<Record<Severity, BrokkExpression>> = { grave: "sigh" };

export function sceneWaitGestureOf(severity: Severity): BrokkExpression {
    return SceneWaitGestures[severity] ?? null;
}

// The pose he waits in: the package's listening loop, with the gestures it draws there by chance (the blink, the glance
// aside, the deep breath, the look around, the hand in the beard, the scratch); the faces are on demand only.
export const ScenePose = "listening";

// The waiting gesture comes after a wait drawn anew each time between these two, counted from the end of the last
// gesture asked of him.
export const SceneRecurGap = { minMs: 20_000, maxMs: 40_000 };

export function sceneRecurDelayMs(random: number): number {
    const share = Math.min(Math.max(random, 0), 1);
    return Math.round(SceneRecurGap.minMs + share * (SceneRecurGap.maxMs - SceneRecurGap.minMs));
}

// The waiting gesture never cuts a gesture the package drew by chance, nor follows one back to back: it waits for its
// end, then a round of his loop (4.5 s, the least the package itself leaves between two gestures it draws). A gesture
// whose end never comes is let go after DrawnCapMs, longer than any he ships (brokk-visit-scene-model.test.ts measures
// them).
export const SceneQuietMs = 4_500;
export const DrawnCapMs = 10_000;

// A gesture asked of the package: a new cue plays the same gesture again.
export type SceneCue = { expression: BrokkExpression; cue: number };

export type SceneClock = {
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    random: () => number;
};

export type SceneGestures = {
    // What the package says of a gesture (its onGesture): one of his own, or one it drew by chance.
    heard: (name: string, phase: "start" | "end") => void;
    stop: () => void;
};

// Plays the face of the severity at once (his arrival), then, when the visit has a waiting gesture, that gesture after
// each wait. Should the package never say a gesture of his ended (a clip that cannot play says nothing), the next one
// still comes, `capMs` of it (the longest it can last) plus a wait after it was asked, so that two never follow each
// other without a wait between.
export function startSceneGestures(
    clock: SceneClock,
    gestures: { arrival: BrokkExpression; wait: BrokkExpression },
    capMs: (expression: BrokkExpression) => number,
    play: (cue: SceneCue) => void
): SceneGestures {
    let played = 0;
    let timer: unknown = null;
    let stopped = false;
    // The gesture the package drew by chance that plays now, and whether the waiting gesture waits for its end.
    let drawn: string = null;
    let held = false;
    const own = (name: string) => name === gestures.arrival || name === gestures.wait;
    const clear = () => {
        if (timer != null) {
            clock.clearTimer(timer);
        }
        timer = null;
    };
    const arm = (ms: number, run: () => void) => {
        clear();
        timer = clock.setTimer(run, ms);
    };
    const start = (expression: BrokkExpression) => {
        played++;
        play({ expression, cue: played });
        if (gestures.wait != null) {
            arm(capMs(expression) + sceneRecurDelayMs(clock.random()), due);
        }
    };
    function due() {
        timer = null;
        if (stopped) {
            return;
        }
        if (drawn != null) {
            held = true;
            arm(DrawnCapMs, letGo);
            return;
        }
        start(gestures.wait);
    }
    function letGo() {
        timer = null;
        drawn = null;
        held = false;
        due();
    }
    start(gestures.arrival);
    return {
        heard: (name, phase) => {
            if (stopped) {
                return;
            }
            if (!own(name)) {
                if (phase === "start") {
                    drawn = name;
                    return;
                }
                if (drawn === name) {
                    drawn = null;
                }
                if (held) {
                    held = false;
                    arm(SceneQuietMs, due);
                }
                return;
            }
            if (phase === "end" && gestures.wait != null) {
                arm(sceneRecurDelayMs(clock.random()), due);
            }
        },
        stop: () => {
            stopped = true;
            clear();
        },
    };
}

export const LaterLabelKeys: Record<SnoozeChoiceId, string> = {
    "5min": "boss.visit.later.5min",
    "15min": "boss.visit.later.15min",
    "1h": "boss.visit.later.1h",
    tonight: "boss.visit.later.tonight",
    tomorrow: "boss.visit.later.tomorrow",
};

export type LaterOption = { id: SnoozeChoiceId; labelKey: string; until: number; isDefault: boolean };

// The delays the Plus tard menu offers at this moment, in order; the first is what Escape takes.
export function laterOptions(severity: Severity, now: number): LaterOption[] {
    return snoozeChoices(severity, now).map((choice, i) => ({
        id: choice.id,
        labelKey: LaterLabelKeys[choice.id],
        until: choice.until,
        isDefault: i === 0,
    }));
}

// Enter and Space on the scene are the click of its button: they open his panel, as a click anywhere else on the scene
// does. Escape, wherever the focus is in the scene and whether the menu is open or not, takes the default delay of the
// severity: the menu's first delay is that default. It is heard in the scene only, never in the window: a terminal has
// its own use for Escape.
export function sceneEscapes(key: string, composing: boolean = false): boolean {
    return key === "Escape" && !composing;
}

// What the scene asks of the hub: nothing else is decided in the component.
export type SceneHub = { open: () => void; later: (choice: SnoozeChoiceId | "escape") => void };

export type SceneActions = {
    // A click anywhere else on the scene, Enter or Space on its button: he folds back and his panel opens, in one gesture.
    fold: () => void;
    // A delay of the Plus tard menu.
    choose: (id: SnoozeChoiceId) => void;
    // Escape (sceneEscapes): the default delay of the severity.
    escape: () => void;
};

export function sceneActions(hub: SceneHub): SceneActions {
    return {
        fold: () => hub.open(),
        choose: (id) => hub.later(id),
        escape: () => hub.later("escape"),
    };
}

// The example of "Show a visit" (FR-BOSS-009, AC32, #2079): every action only closes it. It opens no panel, sets no delay
// and records nothing, so the developer can try the scene as often as they like.
export function exampleSceneActions(close: () => void): SceneActions {
    return { fold: close, choose: close, escape: close };
}
