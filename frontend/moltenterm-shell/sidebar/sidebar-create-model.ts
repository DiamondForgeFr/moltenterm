// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The new-workspace page of the sidebar (FR-SHELL-082, FR-SHELL-102): what the form holds, the colours it offers and
// the pending dot it draws in the bottom row.

import { isRedColour, logoColourChoices, ShortPaletteColours } from "../workspace-colour";

// colourPicked: the developer chose the colour; a logo found afterwards no longer replaces it.
export type CreateDraft = { name: string; type: string; folder: string; colour: string; colourPicked?: boolean };

export const CreateColours: string[] = ShortPaletteColours;

const DefaultColours = CreateColours.filter((c) => !isRedColour(c));

export function makeCreateDraft(colour: string): CreateDraft {
    return { name: "", type: "", folder: "", colour: colour || DefaultColours[0] };
}

// The colour a new workspace starts with (Coulée decision 8, #1318): the first of the row that no workspace uses yet
// and is not red, else the next non-red one round.
export function freshColour(used: readonly string[], count: number): string {
    const taken = new Set((used ?? []).map((c) => (c ?? "").toLowerCase()));
    const free = DefaultColours.find((c) => !taken.has(c));
    return free ?? DefaultColours[count % DefaultColours.length];
}

// The colour the project's logo gives the new workspace, its dominant one; "" when the logo has none to offer.
export function logoDefaultColour(logoColours: string[]): string {
    return logoColourChoices(logoColours)[0] ?? "";
}

// The short row, led by the logo's colour when the folder has a logo, so the default is always among the swatches.
export function shortRow(logoColours: string[]): string[] {
    const logo = logoDefaultColour(logoColours);
    return logo && !CreateColours.includes(logo) ? [logo, ...CreateColours] : CreateColours;
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
