// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The ribbon's rules (FR-SHELL-159, #2476, #2519), apart from the components: its paint, the texts the menu and the
// screen reader say, where the collapsed ribbon shows and how the menu's keys move. A ribbon takes the colour of a
// workspace (the workspace keeps its colour; the context reads by its emblem) and the ink that reads on it.

import { MoltentermDefaultAccent, parseColor, readableInk } from "../accent";
import {
    agentStatesOfWorkspace,
    workingAgentCount,
    type AgentStatesData,
} from "../agent-state-model";
import type { TFunction } from "../i18n/i18n";
import { colourChoiceCss, colourChoiceInk, colourStops } from "../workspace-colour";
import type { ContextHint } from "./context-model";

// useTCount()'s function: the plural form of a key for a count.
export type TCountFunction = (key: string, count: number, vars?: Record<string, any>) => string;

export type RibbonPaint = { paint: string; ink: string };

// A workspace without a colour is drawn in the secondary text colour, as its dot is.
export function ribbonPaint(colour: string): RibbonPaint {
    if (colourStops(colour).length === 0) {
        return { paint: "var(--color-secondary)", ink: "var(--mt-text-inverse)" };
    }
    return { paint: colourChoiceCss(colour), ink: colourChoiceInk(colour) };
}

// The window's own ribbon comes out of the liseré down the window's left edge, so it is painted with the liseré's own
// tokens (--mt-place and, for a gradient, its mid and end stops, accent.ts applyPlace): the same colour, not a copy of
// it that could drift. The liseré of a workspace without a colour is MoltenTerm's orange, and so is the ribbon.
export const PlacePaint = "var(--mt-place)";
export const PlaceGradientPaint = "linear-gradient(135deg, var(--mt-place), var(--mt-place-mid), var(--mt-place-end))";

export function windowRibbonPaint(stops: readonly string[]): RibbonPaint {
    const own = stops.length > 0 ? [...stops] : [MoltentermDefaultAccent];
    return { paint: own.length > 1 ? PlaceGradientPaint : PlacePaint, ink: readableInk(own.map(parseColor)) };
}

export const RibbonHeatMaxLevel = 3;

// How hot the window's ribbon runs: 1 to 3 with the agents of its context that work (one, two, three or more), 0 with
// none, when nothing is drawn or runs.
export function ribbonHeatLevel(working: number): number {
    return Math.min(Math.max(working ?? 0, 0), RibbonHeatMaxLevel);
}

// The agents of a workspace that work.
export function workingAgentsIn(data: AgentStatesData, workspaceId: string): number {
    return workingAgentCount(agentStatesOfWorkspace(data, workspaceId));
}

export function hintText(hint: ContextHint, t: TFunction, tc: TCountFunction): string {
    switch (hint.kind) {
        case "here":
            return t("contexts.menu.here");
        case "waiting":
            return tc("contexts.menu.waiting", hint.count);
        default:
            return tc("contexts.menu.workspaces", hint.count);
    }
}

// What the ribbon says to a screen reader: the context, how to change it, and the agents that wait elsewhere.
export function ribbonLabel(name: string, waiting: number, t: TFunction, tc: TCountFunction): string {
    const label = t("contexts.ribbon.label", { name });
    return waiting > 0 ? `${label}. ${tc("contexts.ribbon.waiting", waiting)}` : label;
}

// The agents of a workspace that wait for the developer.
export function waitingAgentsIn(data: AgentStatesData, workspaceId: string): number {
    return agentStatesOfWorkspace(data, workspaceId).filter((s) => s.state === "waiting").length;
}

// The ribbon at the window's edge shows while the sidebar is collapsed and quiet: not while the sidebar slides over it
// (its own ribbon is on screen then) nor while Brokk's strip is out at the same edge (FR-BOSS-009).
export function collapsedRibbonShown(hidden: boolean, peek: boolean, edgeShape: string): boolean {
    return hidden && !peek && edgeShape !== "peek" && edgeShape !== "ajar";
}

// The menu's keys: the index the key moves to among `count` rows, or null for a key it leaves alone.
export function menuKeyTarget(key: string, current: number, count: number): number {
    if (count <= 0) {
        return null;
    }
    switch (key) {
        case "ArrowDown":
            return current < 0 ? 0 : (current + 1) % count;
        case "ArrowUp":
            return current < 0 ? count - 1 : (current - 1 + count) % count;
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return null;
    }
}
