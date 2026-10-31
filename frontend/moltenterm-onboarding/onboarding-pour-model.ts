// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the first launch, "the pour" (FR-ONB-007, DS-ONB-007), decides, kept apart from its components so the rules are
// tested without a window: the five scenes, the keys that move between them, what each move records and the three
// starts of the last scene.

export const PourScenes = ["pour", "agents", "workshop", "morph", "start"] as const;
export type PourScene = (typeof PourScenes)[number];
export const PourSceneCount = PourScenes.length;

export const PourStarts = ["project", "morph", "free"] as const;
export type PourStart = (typeof PourStarts)[number];
export const DefaultStart: PourStart = "project";

// The main button's text on each scene, keys of onboarding.pour.next.<scene>.
export function nextLabelKey(scene: number): string {
    return `onboarding.pour.next.${PourScenes[clampScene(scene)]}`;
}

export function clampScene(scene: number): number {
    if (!Number.isFinite(scene)) {
        return 0;
    }
    return Math.max(0, Math.min(PourSceneCount - 1, Math.trunc(scene)));
}

export function isLastScene(scene: number): boolean {
    return clampScene(scene) === PourSceneCount - 1;
}

export type HeatState = "done" | "now" | "cold";

// The heat bars: the scenes passed glow molten, the current one incandescent.
export function heatStates(scene: number): HeatState[] {
    const current = clampScene(scene);
    return PourScenes.map((_, i) => (i < current ? "done" : i === current ? "now" : "cold"));
}

export type PourKeyAction = "next" | "back" | null;

// Enter or → moves on, ← comes back. Enter on a button is the button's own; a key with a modifier, or typed in a field,
// is not the pour's.
export function pourKeyAction(
    key: string,
    opts: { onButton?: boolean; inField?: boolean; modifier?: boolean } = {}
): PourKeyAction {
    if (opts.modifier || opts.inField) {
        return null;
    }
    if (key === "ArrowRight") {
        return "next";
    }
    if (key === "Enter") {
        return opts.onButton ? null : "next";
    }
    if (key === "ArrowLeft") {
        return "back";
    }
    return null;
}

// What a move forward out of a scene records (FR-ONB-007 AC-9): the welcome when scene 1 is passed, the agent step when
// scene 2 is.
export type PourRecord = "welcome" | "agents" | null;

export function recordOnLeaving(scene: number): PourRecord {
    switch (PourScenes[clampScene(scene)]) {
        case "pour":
            return "welcome";
        case "agents":
            return "agents";
    }
    return null;
}

// The pour's own state: the scene, a visit count that replays a scene's animations each time it shows, the start
// chosen on the last scene and the agent card whose install or recipe is open.
export type PourState = { scene: number; visit: number; start: PourStart; open: string };

export type PourAction =
    | { type: "next" }
    | { type: "back" }
    | { type: "goto"; scene: number }
    | { type: "choose"; start: PourStart }
    | { type: "toggle"; card: string };

export function initialPourState(scene = 0): PourState {
    return { scene: clampScene(scene), visit: 0, start: DefaultStart, open: null };
}

function show(state: PourState, scene: number): PourState {
    const next = clampScene(scene);
    if (next === state.scene) {
        return state;
    }
    return { ...state, scene: next, visit: state.visit + 1 };
}

// Next on the last scene runs the chosen start, which is the view's: the state does not move.
export function pourReduce(state: PourState, action: PourAction): PourState {
    switch (action.type) {
        case "next":
            return show(state, state.scene + 1);
        case "back":
            return show(state, state.scene - 1);
        case "goto":
            return show(state, action.scene);
        case "choose":
            return PourStarts.includes(action.start) ? { ...state, start: action.start } : state;
        case "toggle":
            return { ...state, open: state.open === action.card ? null : action.card };
    }
    return state;
}

// Motion is reduced by the system or by the app's own setting (window:reducedmotion), both in
// atoms.prefersReducedMotionAtom: then no sparks, and every scene appears at once.
export function sparksAllowed(reduced: boolean, documentHidden: boolean): boolean {
    return !reduced && !documentHidden;
}

// The /morph demo types one character every TypeMs, then the agent "writes" for WriteMs before the panel pours.
export const TypeMs = 45;
export const TypePauseMs = 350;
export const WriteMs = 900;
// The workshop's spaces slide on their own every SlideMs (SlideReducedMs under reduced motion).
export const SlideMs = 3200;
export const SlideReducedMs = 6000;
// The Materials popover opens this long after the third space arrives.
export const MaterialsDelayMs = 1300;
