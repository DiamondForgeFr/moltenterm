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

// His accessible name, which is also the tooltip: the scene has no text, so this is all it says.
export function sceneLabel(
    t: (key: string, vars?: Record<string, any>) => string,
    name: string,
    severity: Severity
): string {
    return t("boss.visit.label", { name, severity: t(SeverityLabelKeys[severity]) });
}

// The clips of the package's listening pose he makes each face with.
export const SceneClipNames: Record<BrokkExpression, string> = {
    frown: "listening.frown",
    doubtful: "listening.doubtful",
    call: "listening.call",
    smile: "listening.smile",
    nod: "listening.nod",
};

export function sceneClipOf(severity: Severity): string {
    return SceneClipNames[SeverityExpression[severity]];
}

// The gesture of the severity, which his living portrait plays in the listening pose.
export function sceneGestureOf(severity: Severity): BrokkExpression {
    return SeverityExpression[severity];
}

// The pose he waits in: the package's listening loop, whose free idles are his blinks (the faces are on demand only).
export const ScenePose = "listening";

// While he waits, the face of the severity comes back now and then so that it keeps saying why he came (#2025): after
// a wait drawn anew each time between these two, counted from the end of the last one. Played over and over, it read
// as a machine, not as someone waiting.
export const SceneRecurGap = { minMs: 20_000, maxMs: 40_000 };

export function sceneRecurDelayMs(random: number): number {
    const share = Math.min(Math.max(random, 0), 1);
    return Math.round(SceneRecurGap.minMs + share * (SceneRecurGap.maxMs - SceneRecurGap.minMs));
}

export type SceneClock = {
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    random: () => number;
};

export type SceneGestures = {
    // The package says the gesture has left the screen: the next one waits a fresh gap from now.
    ended: () => void;
    stop: () => void;
};

// Plays the gesture once at once (his arrival), then again after each wait. `cue` receives a new number for each play,
// the package's way to play the same gesture again. Should the package never say the gesture ended (a clip that cannot
// play says nothing), the next one still comes, `capMs` (the longest the gesture can last) plus a wait after it was
// asked, so that two never follow each other without a wait between.
export function startSceneGestures(clock: SceneClock, capMs: number, cue: (n: number) => void): SceneGestures {
    let played = 0;
    let timer: unknown = null;
    let stopped = false;
    const clear = () => {
        if (timer != null) {
            clock.clearTimer(timer);
        }
        timer = null;
    };
    const arm = (ms: number) => {
        clear();
        timer = clock.setTimer(play, ms);
    };
    function play() {
        timer = null;
        if (stopped) {
            return;
        }
        played++;
        cue(played);
        arm(capMs + sceneRecurDelayMs(clock.random()));
    }
    play();
    return {
        ended: () => {
            if (stopped) {
                return;
            }
            arm(sceneRecurDelayMs(clock.random()));
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
