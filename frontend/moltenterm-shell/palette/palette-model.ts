// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The command palette (FR-SHELL-013, DS-SHELL-013): one filterable, grouped list served by an empty pane and by the
// global shortcut. This file holds the rules (fuzzy match, grouping, keyboard) as pure functions, tested without the
// app; palette-sources.ts builds the entries and palette-actions.ts runs them.

export type PaletteGroupId = "agents" | "panels" | "folders" | "actions";

export const PaletteGroupOrder: PaletteGroupId[] = ["agents", "panels", "folders", "actions"];

// What choosing an entry does, as data so the sources stay testable; palette-actions.ts carries it out.
export type PaletteRun =
    | { kind: "agent"; command: string }
    | { kind: "widget"; blockdef: BlockDef }
    | { kind: "folder"; path: string }
    | { kind: "newtab" }
    | { kind: "newworkspace" }
    | { kind: "switchworkspace"; workspaceId: string }
    | { kind: "settings" };

export type PaletteEntry = {
    id: string;
    group: PaletteGroupId;
    label: string;
    // Secondary text after the label (a full path, a description).
    detail?: string;
    icon: string;
    color?: string;
    // The command line that does the same thing, shown so the palette teaches the CLI (Terminal first).
    cli?: string;
    // A key hint shown instead of the CLI when an entry has no command line (a shortcut).
    hint?: string;
    // Extra words the filter matches, with less weight than the label.
    keywords?: string[];
    run: PaletteRun;
};

export type PaletteSection = { group: PaletteGroupId; title: string; entries: PaletteEntry[] };

export type PaletteMatch = { score: number; indices: number[] };

const WordSeparators = /[\s\-_./\\:@()]/;
const ScoreChar = 1;
const ScoreConsecutive = 4;
const ScoreWordStart = 3;
const ScorePrefix = 8;
const PenaltyGap = 0.05;
// A query found only in an entry's secondary text (detail, CLI, keywords) ranks below a match of its label.
const SecondaryWeight = 0.5;

function isWordStart(text: string, index: number): boolean {
    if (index === 0) {
        return true;
    }
    const prev = text[index - 1];
    const cur = text[index];
    if (WordSeparators.test(prev)) {
        return true;
    }
    // camelCase and PascalCase boundaries ("CiCd", "OpenCode")
    return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

// Every query character must appear in order in text, case-insensitively. Each character prefers, from where the
// previous one matched, the next word start over a plain occurrence, so "cc" finds "Claude Code" by its initials.
// Returns null when the query is not a subsequence of text.
export function fuzzyMatch(query: string, text: string): PaletteMatch {
    const q = (query ?? "").trim().toLowerCase();
    if (q === "") {
        return { score: 0, indices: [] };
    }
    const source = text ?? "";
    const lower = source.toLowerCase();
    const indices: number[] = [];
    let score = 0;
    let from = 0;
    for (let qi = 0; qi < q.length; qi++) {
        const ch = q[qi];
        if (ch === " ") {
            continue;
        }
        const prevIndex = indices.length > 0 ? indices[indices.length - 1] : -1;
        let found = -1;
        if (prevIndex >= 0 && lower[prevIndex + 1] === ch) {
            found = prevIndex + 1;
        } else {
            for (let i = from; i < lower.length; i++) {
                if (lower[i] === ch && isWordStart(source, i)) {
                    found = i;
                    break;
                }
            }
            if (found === -1) {
                found = lower.indexOf(ch, from);
            }
        }
        if (found === -1) {
            return null;
        }
        score += ScoreChar;
        if (prevIndex >= 0 && found === prevIndex + 1) {
            score += ScoreConsecutive;
        } else if (prevIndex >= 0) {
            score -= (found - prevIndex - 1) * PenaltyGap;
        }
        if (isWordStart(source, found)) {
            score += ScoreWordStart;
        }
        indices.push(found);
        from = found + 1;
    }
    if (lower.startsWith(q)) {
        score += ScorePrefix;
    }
    return { score, indices };
}

// The best match of an entry: its label first, then its secondary texts at a lower weight. indices always refer to
// the label (empty when only a secondary text matched).
export function matchEntry(query: string, entry: PaletteEntry): PaletteMatch {
    const label = fuzzyMatch(query, entry.label);
    let best: PaletteMatch = label;
    const secondary = [entry.detail, entry.cli, ...(entry.keywords ?? [])].filter((s) => s);
    for (const text of secondary) {
        const m = fuzzyMatch(query, text);
        if (m == null) {
            continue;
        }
        const weighted = m.score * SecondaryWeight;
        if (best == null || weighted > best.score) {
            best = { score: weighted, indices: label?.indices ?? [] };
        }
    }
    return best;
}

// Groups keep a fixed order (agents, panels, folders, workspace) so the list does not jump while typing; inside a
// group, the entries keep their source order until a query ranks them. Empty groups are left out.
export function filterPalette(
    entries: PaletteEntry[],
    query: string,
    titles: Partial<Record<PaletteGroupId, string>> = {}
): PaletteSection[] {
    const q = (query ?? "").trim();
    const sections: PaletteSection[] = [];
    for (const group of PaletteGroupOrder) {
        const inGroup = (entries ?? []).filter((e) => e.group === group);
        let kept: PaletteEntry[];
        if (q === "") {
            kept = inGroup;
        } else {
            kept = inGroup
                .map((entry, order) => ({ entry, order, match: matchEntry(q, entry) }))
                .filter((r) => r.match != null)
                .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
                .map((r) => r.entry);
        }
        if (kept.length > 0) {
            sections.push({ group, title: titles[group] ?? DefaultGroupTitles[group], entries: kept });
        }
    }
    return sections;
}

export const DefaultGroupTitles: Record<PaletteGroupId, string> = {
    agents: "Agents",
    panels: "Panels",
    folders: "Recent folders",
    actions: "Workspace",
};

export function flattenSections(sections: PaletteSection[]): PaletteEntry[] {
    return (sections ?? []).flatMap((s) => s.entries);
}

export type PaletteKeyCommand = "up" | "down" | "first" | "last" | "open" | "open-right" | "close";

export type PaletteKey = { key: string; shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean };

// Keyboard first: arrows (and Ctrl+N / Ctrl+P, as in shells and editors) choose, Enter opens in place, Tab opens to
// the right, Esc closes. Shift+Tab is left to the browser so focus can still leave the palette.
export function paletteKeyCommand(e: PaletteKey): PaletteKeyCommand {
    const plain = !e.shift && !e.ctrl && !e.meta && !e.alt;
    if (e.key === "ArrowDown" && plain) {
        return "down";
    }
    if (e.key === "ArrowUp" && plain) {
        return "up";
    }
    if (e.ctrl && !e.shift && !e.meta && !e.alt && (e.key === "n" || e.key === "p")) {
        return e.key === "n" ? "down" : "up";
    }
    if (e.key === "PageUp" && plain) {
        return "first";
    }
    if (e.key === "PageDown" && plain) {
        return "last";
    }
    if (e.key === "Enter" && plain) {
        return "open";
    }
    if (e.key === "Tab" && plain) {
        return "open-right";
    }
    if (e.key === "Escape" && plain) {
        return "close";
    }
    return null;
}

// The selection wraps around both ends; an empty list has no selection (-1).
export function moveSelection(index: number, command: PaletteKeyCommand, count: number): number {
    if (count <= 0) {
        return -1;
    }
    const current = index < 0 || index >= count ? 0 : index;
    switch (command) {
        case "down":
            return (current + 1) % count;
        case "up":
            return (current - 1 + count) % count;
        case "first":
            return 0;
        case "last":
            return count - 1;
        default:
            return current;
    }
}

// Splits text into plain and highlighted runs for the matched characters.
export function highlightRuns(text: string, indices: number[]): { text: string; hit: boolean }[] {
    const set = new Set(indices ?? []);
    const runs: { text: string; hit: boolean }[] = [];
    for (let i = 0; i < (text ?? "").length; i++) {
        const hit = set.has(i);
        const last = runs[runs.length - 1];
        if (last != null && last.hit === hit) {
            last.text += text[i];
        } else {
            runs.push({ text: text[i], hit });
        }
    }
    return runs;
}
