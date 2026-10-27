// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The new-workspace page of the sidebar (FR-SHELL-082): what the form holds, the colours it offers and the pending dot
// it draws in the bottom row.

import { PresetColours } from "../workspace-colour";

export type CreateDraft = { name: string; type: string; folder: string; colour: string };

// A short row of the presets spread around the hue wheel, as the prototype's swatches.
const CreateColourNames = ["red", "orange", "amber", "lime", "green", "teal", "sky", "blue", "violet", "pink"];

export const CreateColours: string[] = CreateColourNames.map(
    (name) => PresetColours.find((c) => c.name === name)?.value
).filter((v) => !!v);

export function makeCreateDraft(colour: string): CreateDraft {
    return { name: "", type: "", folder: "", colour: colour || CreateColours[0] };
}

// The colour a new workspace starts with: the first of the row no workspace uses yet, else the next one round.
export function freshColour(used: readonly string[], count: number): string {
    const taken = new Set((used ?? []).map((c) => (c ?? "").toLowerCase()));
    const free = CreateColours.find((c) => !taken.has(c));
    return free ?? CreateColours[count % CreateColours.length];
}

// The pending dot's letter: the name's first letter as typed, "+" until there is one.
export function pendingLetter(name: string): string {
    const first = Array.from((name ?? "").trim())[0];
    return first ? first.toUpperCase() : "+";
}

// The project type suggestions, from a translated comma-separated list.
export function typeSuggestions(list: string): string[] {
    return (list ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
}
