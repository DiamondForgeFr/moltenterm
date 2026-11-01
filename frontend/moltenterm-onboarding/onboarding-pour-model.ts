// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the first launch, "the pour" (FR-ONB-007, DS-ONB-007), decides, kept apart from its components so the rules are
// tested without a window: the six scenes (#1709), the keys that move between them, what each move records, and the
// choices of the project, first-view and place scenes (FR-ONB-009).

import {
    DefaultPlace,
    DefaultProjectMode,
    DefaultToolsSuggestion,
    presetTools,
    ProjectDraft,
    ProjectResult,
    toggleTool,
    ViewPlace,
} from "./onboarding-first-view-model";

export const PourScenes = ["pour", "agents", "project", "view", "place", "start"] as const;
export type PourScene = (typeof PourScenes)[number];
export const PourSceneCount = PourScenes.length;

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

export function sceneIndex(id: PourScene): number {
    return PourScenes.indexOf(id);
}

export function isLastScene(scene: number): boolean {
    return clampScene(scene) === PourSceneCount - 1;
}

// Later skips only the project step, or the view and its place (P-1).
export function offersLater(scene: number): boolean {
    const id = PourScenes[clampScene(scene)];
    return id === "project" || id === "view";
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

// What a move forward out of a scene records at once (FR-ONB-007 AC-9): the welcome when scene 1 is passed, the agent
// step when scene 2 is. The project scene records when its project is set (P-7), the view when the run ends.
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

// The pour's own state: the scene, a visit count that replays a scene's animations each time it shows, the agent card
// whose install or recipe is open, and what the project, view and place scenes hold.
export type PourState = {
    scene: number;
    visit: number;
    open: string;
    project: ProjectDraft;
    // the project the scene set when left; null until then, and after Later
    projectSet: ProjectResult;
    projectSkipped: boolean;
    tools: string[];
    viewName: string;
    // the user typed the name: it no longer follows the tools
    named: boolean;
    agent: string;
    place: ViewPlace;
    viewSkipped: boolean;
};

export type PourAction =
    | { type: "next" }
    | { type: "back" }
    | { type: "goto"; scene: number }
    | { type: "toggle"; card: string }
    | { type: "project"; patch: Partial<ProjectDraft> }
    | { type: "projectSet"; result: ProjectResult }
    | { type: "laterProject" }
    | { type: "tool"; kind: string }
    | { type: "preset"; id: string }
    | { type: "name"; text: string }
    | { type: "agent"; id: string }
    | { type: "place"; place: ViewPlace }
    | { type: "laterView" };

export function initialPourState(scene = 0): PourState {
    return {
        scene: clampScene(scene),
        visit: 0,
        open: null,
        project: { mode: DefaultProjectMode, name: "", location: "", git: true, found: "" },
        projectSet: null,
        projectSkipped: false,
        tools: presetTools(DefaultToolsSuggestion),
        viewName: "",
        named: false,
        agent: null,
        place: DefaultPlace,
        viewSkipped: false,
    };
}

// Showing the project or the view scene again takes back its Later.
function show(state: PourState, scene: number): PourState {
    const next = clampScene(scene);
    if (next === state.scene) {
        return state;
    }
    const rtn = { ...state, scene: next, visit: state.visit + 1 };
    if (PourScenes[next] === "project") {
        rtn.projectSkipped = false;
    }
    if (PourScenes[next] === "view") {
        rtn.viewSkipped = false;
    }
    return rtn;
}

// Next on the last scene ends the run, which is the view's: the state does not move. Back from the last scene after
// Later on the view goes to the view scene, its place having been skipped.
export function pourReduce(state: PourState, action: PourAction): PourState {
    switch (action.type) {
        case "next":
            return show(state, state.scene + 1);
        case "back":
            if (PourScenes[state.scene] === "start" && state.viewSkipped) {
                return show(state, sceneIndex("view"));
            }
            return show(state, state.scene - 1);
        case "goto":
            return show(state, action.scene);
        case "toggle":
            return { ...state, open: state.open === action.card ? null : action.card };
        case "project":
            return { ...state, project: { ...state.project, ...action.patch } };
        case "projectSet":
            return { ...state, projectSet: action.result, projectSkipped: false };
        case "laterProject": {
            const rtn = show({ ...state, projectSet: null }, sceneIndex("view"));
            return { ...rtn, projectSkipped: true };
        }
        case "tool":
            return { ...state, tools: toggleTool(state.tools, action.kind) };
        case "preset":
            return { ...state, tools: presetTools(action.id), named: false, viewName: "" };
        case "name":
            return { ...state, viewName: action.text, named: action.text.trim() !== "" };
        case "agent":
            return { ...state, agent: action.id };
        case "place":
            return { ...state, place: action.place === "workspace" ? "workspace" : "everywhere" };
        case "laterView": {
            const rtn = show(state, sceneIndex("start"));
            return { ...rtn, viewSkipped: true };
        }
    }
    return state;
}

// Motion is reduced by the system or by the app's own setting (window:reducedmotion), both in
// atoms.prefersReducedMotionAtom: then no sparks, and every scene appears at once.
export function sparksAllowed(reduced: boolean, documentHidden: boolean): boolean {
    return !reduced && !documentHidden;
}
