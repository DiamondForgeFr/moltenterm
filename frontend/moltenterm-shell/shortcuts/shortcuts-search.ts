// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The shortcuts sheet's search (DS-SHELL-067): every word of the query must appear in the label, the category, the
// keywords or the keys as shown ("split", "⌘D", "alt+d").

import { formatShortcut } from "./format";
import { Shortcut, ShortcutCategories, ShortcutCategory } from "./registry";

export type ShortcutSection = { category: ShortcutCategory; shortcuts: Shortcut[] };

function haystack(s: Shortcut, mac: boolean): string {
    const keys = [formatShortcut(s, mac), ...(s.alt ?? [])].join(" ");
    return [s.label, s.category, ...(s.keywords ?? []), keys].join(" ").toLowerCase();
}

export function filterShortcuts(list: Shortcut[], query: string, mac: boolean): ShortcutSection[] {
    const words = (query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== "");
    const kept = (list ?? []).filter((s) => {
        const text = haystack(s, mac);
        return words.every((w) => text.includes(w));
    });
    return ShortcutCategories.map((category) => ({
        category,
        shortcuts: kept.filter((s) => s.category === category),
    })).filter((section) => section.shortcuts.length > 0);
}
