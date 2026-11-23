// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The emblem picker's rules (FR-SHELL-158, #2476), apart from the component: the suggestions it opens on, how the
// search matches Lucide's icon names and how the arrow keys move through its grid.

export const EmblemColumns = 8;
export const EmblemResultLimit = 96;

// What the picker shows before anything is typed: names that read as an activity, when the catalog has them.
export const SuggestedEmblems = [
    "briefcase",
    "building-2",
    "hammer",
    "code-xml",
    "laptop",
    "book-open",
    "pen-tool",
    "palette",
    "music",
    "camera",
    "graduation-cap",
    "flask-conical",
    "rocket",
    "lightbulb",
    "sparkles",
    "users",
    "heart",
    "house",
    "wallet",
    "shopping-cart",
    "plane",
    "globe",
    "leaf",
    "dumbbell",
    "gamepad-2",
    "wrench",
    "scale",
    "stethoscope",
];

export type EmblemMatches = {
    shown: string[];
    // The matches left out: the search is to be narrowed.
    hidden: number;
};

function tokensOf(query: string): string[] {
    return query
        .toLowerCase()
        .split(/[\s-]+/)
        .filter((token) => token !== "");
}

// Icons whose name holds every word of the query, the ones that start with it first, then the shorter names. No query
// shows the suggestions that exist in the catalog.
export function matchEmblems(names: readonly string[], query: string, limit: number = EmblemResultLimit): EmblemMatches {
    const tokens = tokensOf(query);
    if (tokens.length === 0) {
        const known = new Set(names);
        return { shown: SuggestedEmblems.filter((name) => known.has(name)), hidden: 0 };
    }
    const joined = tokens.join("-");
    const found = names.filter((name) => tokens.every((token) => name.includes(token)));
    const rank = (name: string) => (name === joined ? 0 : name.startsWith(tokens[0]) ? 1 : 2);
    found.sort((a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : 1));
    return { shown: found.slice(0, limit), hidden: Math.max(0, found.length - limit) };
}

// The index an arrow key moves to in a grid of `columns`, or null for a key it leaves alone. Left and right wrap along
// the whole list; up and down stay put at the first and last rows.
export function gridMove(index: number, key: string, columns: number, count: number): number {
    if (count <= 0) {
        return null;
    }
    switch (key) {
        case "ArrowRight":
            return (index + 1) % count;
        case "ArrowLeft":
            return (index - 1 + count) % count;
        case "ArrowDown":
            return index + columns < count ? index + columns : index;
        case "ArrowUp":
            return index - columns >= 0 ? index - columns : index;
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return null;
    }
}
