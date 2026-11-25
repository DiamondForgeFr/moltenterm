// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The command palette (FR-SHELL-013, DS-SHELL-013): one filterable, grouped list served by an empty pane and by the
// global shortcut. This file holds the rules (fuzzy match, grouping, keyboard) as pure functions, tested without the
// app; palette-sources.ts builds the entries and palette-actions.ts runs them.

import { t } from "../i18n/i18n";
import type { GlyphIcon } from "../sidebar/view-menu-model";
import type { WorkspaceIconSource } from "../workspace-icon-model";

// "panel": the focused panel's command panel items (FR-SHELL-047), listed only while a query is typed. "suggestions":
// the ready-made combinations a new view's chooser offers above its list (FR-SHELL-138); no other list holds them.
// "web": what the typed words do on the web (#2312): the "Search the web" row and the address row, which sit first or
// last in every palette's order (webGroupOrder), the chooser's and since #2545 the open palette's and a split picker's.
export type PaletteGroupId = "suggestions" | "agents" | "panels" | "folders" | "actions" | "panel" | "web";

export const PaletteGroupOrder: PaletteGroupId[] = ["suggestions", "agents", "panels", "folders", "actions", "panel"];

// The picker of a split panel puts the panel kinds first (FR-SHELL-042, DS-SHELL-066).
export const PickerGroupOrder: PaletteGroupId[] = ["panels", "agents", "folders", "actions"];

// What choosing an entry does, as data so the sources stay testable; palette-actions.ts carries it out.
export type PaletteRun =
    | { kind: "agent"; command: string }
    | { kind: "widget"; blockdef: BlockDef }
    | { kind: "folder"; path: string }
    | { kind: "newtab" }
    | { kind: "newworkspace" }
    | { kind: "switchworkspace"; workspaceId: string }
    // The edit sheet of the workspace the window shows (FR-SHELL-030).
    | { kind: "editworkspace" }
    | { kind: "settings" }
    // The workspace's Project tab (FR-SHELL-015): shown, or made again after the user closed it.
    | { kind: "projecttab" }
    // MoltenTerm's first run (FR-ONB-001): the workspace's panel, or a new one docked on the left.
    | { kind: "gettingstarted" }
    // The Sessions view (FR-SHELL-020).
    | { kind: "sessions" }
    // The foreman's Sessions card over the app (FR-BOSS-002), anchored to his bubble.
    | { kind: "bosscard" }
    // A brainstorm with him (FR-BOSS-010, #2246), and its scripted replay on dev and local builds.
    | { kind: "brainstorm" }
    | { kind: "brainstormreplay" }
    // The brainstorm last left, opened again where it was (#2284).
    | { kind: "brainstormresume" }
    // Back to the pane the palette was opened from, to type an agent's own command there.
    | { kind: "focusorigin" }
    // The browser panel's active page, handed off to the installed browser (FR-BRW-002).
    | { kind: "openinbrowser" }
    // Every terminal started before MoltenTerm's update, brought up to date (FR-SHELL-041).
    | { kind: "updateterminals" }
    // The shortcuts sheet (FR-SHELL-042, DS-SHELL-067).
    | { kind: "shortcuts" }
    // Check for updates now (#1806): asks GitHub at once, whatever the day's check said.
    | { kind: "checkupdates" }
    // The workspace's last closed pane or tab, back (#512).
    | { kind: "reopenclosed" }
    // The split placement mode on the pane the palette was opened from, or the focused one (#677).
    | { kind: "splitplace" }
    // Equalize the panel widths of the tab on screen (#825).
    | { kind: "equalize" }
    // A pin move of the view on screen, as its menu makes it (#1652).
    | { kind: "pinview"; move: "here" | "everywhere" | "temporary" }
    // The command panel of the pane the palette was opened from, or one of its items (FR-SHELL-047: every action of
    // the panel is also a palette command).
    | { kind: "panelcommands" }
    | { kind: "panelcommand"; entryId: string }
    // A ready-made combination of panels (FR-SHELL-138), by its id in workspace-views/view-suggestions.ts.
    | { kind: "suggestion"; id: string };

// The entries that open something in the palette's pane; the others act elsewhere (a tab, a sheet, a workspace).
export function fillsPanel(run: PaletteRun): boolean {
    return run?.kind === "widget" || run?.kind === "folder" || run?.kind === "agent";
}

// What Enter does with an entry (FR-SHELL-013, FR-SHELL-042): "fill" opens it where the placement says, and in a
// split's picker that is the new panel, whose split it consumes; "elsewhere" is an action that opens nothing in the
// new panel (a tab, the settings, a workspace), which cancels the split first so no empty panel stays behind.
export type PaletteOpenPlan =
    | { kind: "fill"; placement: "replace" | "new" | "right"; consumeSplit: boolean }
    | { kind: "elsewhere"; focusOrigin: boolean };

export function paletteOpenPlan(
    run: PaletteRun,
    target: { inPlace: "replace" | "new" | "right"; right: boolean; blockId: string; picker: boolean }
): PaletteOpenPlan {
    if (target.picker && !fillsPanel(run)) {
        return { kind: "elsewhere", focusOrigin: run?.kind === "focusorigin" };
    }
    const placement = target.right && target.blockId && !target.picker ? "right" : target.inPlace;
    return { kind: "fill", placement, consumeSplit: target.picker };
}

export type PaletteEntry = {
    id: string;
    group: PaletteGroupId;
    label: string;
    // Secondary text after the label (a full path, a description).
    detail?: string;
    icon: string;
    color?: string;
    // A workspace's badge, resolved as the rail resolves it, in place of icon and color (FR-SHELL-031).
    badge?: WorkspaceIconSource;
    // The command line that does the same thing, shown so the palette teaches the CLI (Terminal first).
    cli?: string;
    // A key hint shown instead of the CLI when an entry has no command line (a shortcut).
    hint?: string;
    // Extra words the filter matches, with less weight than the label.
    keywords?: string[];
    // In a split's picker: how to reach the entry from the keyboard ("⌘D co ↵"), and its own global shortcut.
    keyPath?: string;
    shortcut?: string;
    // A suggestion's panels, their icons shown before its detail (FR-SHELL-138); a 360 carpet is a cube (#1823).
    panelIcons?: GlyphIcon[];
    // Letters on a tile in place of the icon: the search engine's mark (#2312), which needs no network call.
    mark?: string;
    // An agent row's agent id: the row shows its provider's own mark when the set of provider marks has one (#2542),
    // else the icon.
    agent?: string;
    run: PaletteRun;
};

// The "Open <address>" row (#1229): typed text that is an address; it is not filtered and always ranks first.
export const AddressEntryId = "address:open";
// The chooser's "Search the web for <words>" row (#2312): not filtered, never selected over a visible match.
export const WebSearchEntryId = "web:search";

export type PaletteSection = { group: PaletteGroupId; title: string; entries: PaletteEntry[] };

export type PaletteMatch = { score: number; indices: number[] };

const WordSeparators = /[\s\-_./\\:@()›]/;
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

// Lowercase without accents, one character for one, so match indices still point into the shown text (#1670):
// "epingler" finds "Épingler".
function foldChars(text: string): string {
    let out = "";
    for (const ch of text.toLowerCase()) {
        const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
        out += base.length === ch.length ? base : ch;
    }
    return out;
}

// Every query character must appear in order in text, case- and accent-insensitively. Each character prefers, from where the
// previous one matched, the next word start over a plain occurrence, so "cc" finds "Claude Code" by its initials.
// Returns null when the query is not a subsequence of text.
export function fuzzyMatch(query: string, text: string): PaletteMatch {
    const q = foldChars((query ?? "").trim());
    if (q === "") {
        return { score: 0, indices: [] };
    }
    const source = text ?? "";
    const lower = foldChars(source);
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

// Stricter than fuzzyMatch (#2312): a loose subsequence ("font" in "Force restart controller") is noise, so a match
// counts when the query is a substring of the text, or when every run of matched characters starts a word ("fs" →
// "Font size", "cc" → "Claude Code"). contiguous says which of the two it was. The command panel's panelMatch is this.
export function strictMatch(query: string, text: string): PaletteMatch & { contiguous: boolean } {
    const q = foldChars((query ?? "").trim());
    if (q === "" || !text) {
        return null;
    }
    const m = fuzzyMatch(q, text);
    if (m == null) {
        return null;
    }
    const at = foldChars(text).indexOf(q);
    if (at >= 0) {
        const indices = Array.from({ length: q.length }, (_, i) => at + i).filter((i) => text[i] !== " ");
        return { score: Math.max(m.score, q.length * 2 + (at === 0 ? 8 : 0)), indices, contiguous: true };
    }
    for (let i = 0; i < m.indices.length; i++) {
        const runStart = i === 0 || m.indices[i] !== m.indices[i - 1] + 1;
        if (runStart && !isWordStart(text, m.indices[i])) {
            return null;
        }
    }
    return { ...m, contiguous: false };
}

// Where the typed letters were found in an entry, best first (#2312): "label" a contiguous match of its label, "word"
// the letters starting words of the label, "detail" the same in the text shown beside it (its detail, its command
// line), "keyword" a search word the screen does not show, "loose" scattered letters, ranked last.
export type MatchKind = "label" | "word" | "detail" | "keyword" | "loose";

// What a match shows: the kinds the developer can see on the row. A "keyword" or "loose" match is not a reason to select
// the result over a web search (the chooser), since nothing on screen says why it matches.
export function isVisibleMatch(kind: MatchKind): boolean {
    return kind === "label" || kind === "word" || kind === "detail";
}

export type EntryMatch = PaletteMatch & {
    kind: MatchKind;
    // The highlights of the detail shown beside the label, when it matched.
    detailIndices?: number[];
    // The search word that found an entry the screen does not otherwise explain, with its matched letters.
    keyword?: string;
    keywordIndices?: number[];
};

// A tier outranks every score of the next one: scores of one text stay under 1000.
const KindBase: Record<MatchKind, number> = { label: 4000, word: 3000, detail: 2000, keyword: 1000, loose: 0 };

function bestStrict(query: string, texts: string[]): { text: string; match: ReturnType<typeof strictMatch> } {
    let best: { text: string; match: ReturnType<typeof strictMatch> } = null;
    for (const text of texts) {
        const match = strictMatch(query, text);
        if (match != null && (best == null || match.score > best.match.score)) {
            best = { text, match };
        }
    }
    return best;
}

// The best match of an entry, with where it was found. indices always refer to the label (empty when it did not match
// by itself). Null when the query is not even a subsequence of any of its texts.
export function entryMatch(query: string, entry: PaletteEntry): EntryMatch {
    if ((query ?? "").trim() === "") {
        return { score: 0, indices: [], kind: "label" };
    }
    const label = strictMatch(query, entry.label);
    if (label != null) {
        const kind: MatchKind = label.contiguous ? "label" : "word";
        return { score: KindBase[kind] + label.score, indices: label.indices, kind };
    }
    const detail = strictMatch(query, entry.detail);
    if (detail != null) {
        return { score: KindBase.detail + detail.score, indices: [], kind: "detail", detailIndices: detail.indices };
    }
    // The command line shows at the right of the row, unless the entry has a key path in its place (a split's picker).
    const cli = entry.keyPath ? null : strictMatch(query, entry.cli);
    if (cli != null) {
        return { score: KindBase.detail + cli.score, indices: [], kind: "detail" };
    }
    const words = bestStrict(
        query,
        [...(entry.keyPath ? [entry.cli] : []), ...(entry.keywords ?? [])].filter((s) => s)
    );
    if (words != null) {
        const shown = (entry.keywords ?? []).includes(words.text);
        return {
            score: KindBase.keyword + words.match.score,
            indices: [],
            kind: "keyword",
            keyword: shown ? words.text : undefined,
            keywordIndices: shown ? words.match.indices : undefined,
        };
    }
    const loose = fuzzyMatch(query, entry.label);
    let best: EntryMatch = loose != null ? { score: loose.score, indices: loose.indices, kind: "loose" } : null;
    for (const text of [entry.detail, entry.cli, ...(entry.keywords ?? [])].filter((s) => s)) {
        const m = fuzzyMatch(query, text);
        const weighted = m != null ? m.score * SecondaryWeight : null;
        if (weighted != null && (best == null || weighted > best.score)) {
            best = { score: weighted, indices: loose?.indices ?? [], kind: "loose" };
        }
    }
    return best;
}

// The entry's match as the ranking sees it: its score and the highlights of its label.
export function matchEntry(query: string, entry: PaletteEntry): PaletteMatch {
    const m = entryMatch(query, entry);
    return m == null ? null : { score: m.score, indices: m.indices };
}

// Groups keep a fixed order (agents, panels, folders, workspace) so the list does not jump while typing; inside a
// group, the entries keep their source order until a query ranks them. Empty groups are left out.
export function filterPalette(
    entries: PaletteEntry[],
    query: string,
    titles: Partial<Record<PaletteGroupId, string>> = {},
    order: PaletteGroupId[] = PaletteGroupOrder
): PaletteSection[] {
    const q = (query ?? "").trim();
    const sections: PaletteSection[] = [];
    for (const group of order) {
        const inGroup = (entries ?? []).filter((e) => e.group === group);
        let kept: PaletteEntry[];
        if (q === "") {
            kept = inGroup;
        } else {
            kept = inGroup
                .map((entry, order) => ({
                    entry,
                    order,
                    match:
                        entry.id === AddressEntryId || entry.group === "web"
                            ? { score: Infinity, indices: [] }
                            : matchEntry(q, entry),
                }))
                .filter((r) => r.match != null)
                .sort(
                    (a, b) =>
                        (a.match.score === b.match.score ? 0 : b.match.score > a.match.score ? 1 : -1) ||
                        a.order - b.order
                )
                .map((r) => r.entry);
        }
        if (kept.length > 0) {
            const key = DefaultGroupTitleKeys[group];
            sections.push({ group, title: titles[group] ?? (key != null ? t(key) : ""), entries: kept });
        }
    }
    return sections;
}

// The chooser's order with its web rows (#2312) first, when nothing matches the typed letters visibly or the text is an
// address, or last, below the results that do.
export function webGroupOrder(order: PaletteGroupId[], first: boolean): PaletteGroupId[] {
    const rest = order.filter((g) => g !== "web");
    return first ? ["web", ...rest] : [...rest, "web"];
}

// Whether any entry is found through what its row shows (#2312): its label, or the text beside it. The web rows are not
// results, and a search word or scattered letters, which nothing on screen explains, are not a reason to choose one.
export function hasVisibleMatch(entries: PaletteEntry[], query: string): boolean {
    if ((query ?? "").trim() === "") {
        return false;
    }
    return (entries ?? []).some((e) => {
        if (e.group === "web" || e.id === AddressEntryId) {
            return false;
        }
        const m = entryMatch(query, e);
        return m != null && isVisibleMatch(m.kind);
    });
}

export const DefaultGroupTitleKeys: Partial<Record<PaletteGroupId, string>> = {
    suggestions: "palette.groups.suggestions",
    agents: "palette.groups.agents",
    panels: "palette.groups.panels",
    folders: "palette.groups.folders",
    actions: "palette.groups.actions",
    panel: "palette.groups.panel",
};

export function flattenSections(sections: PaletteSection[]): PaletteEntry[] {
    return (sections ?? []).flatMap((s) => s.entries);
}

// Groups keep their order, so the best match can sit below a weaker one of an earlier group ("sub" finds the folder
// "sub" by its name and the panel "Web" by its command line): the selection starts on the best match.
export function bestMatchIndex(sections: PaletteSection[], query: string): number {
    const flat = flattenSections(sections);
    if (flat.length === 0) {
        return -1;
    }
    if ((query ?? "").trim() === "") {
        return 0;
    }
    const address = flat.findIndex((entry) => entry.id === AddressEntryId);
    if (address >= 0) {
        return address;
    }
    let best = 0;
    let bestScore = -Infinity;
    let bestKind: MatchKind = null;
    flat.forEach((entry, i) => {
        if (entry.group === "web") {
            return;
        }
        const m = entryMatch(query, entry);
        const score = m?.score ?? -Infinity;
        if (score > bestScore) {
            best = i;
            bestScore = score;
            bestKind = m?.kind ?? null;
        }
    });
    // The words are a web search (#2312) unless a result is found through what its row shows.
    const search = flat.findIndex((entry) => entry.id === WebSearchEntryId);
    if (search >= 0 && (bestKind == null || !isVisibleMatch(bestKind))) {
        return search;
    }
    return best;
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

// The shortest start of an entry's label that, typed in the palette, selects that entry (DS-SHELL-066): the picker
// shows it as the entry's key path. Null when no start of the label does (another entry always ranks higher).
export function shortestSelectingPrefix(
    entries: PaletteEntry[],
    entry: PaletteEntry,
    order: PaletteGroupId[] = PaletteGroupOrder
): string {
    const label = (entry?.label ?? "").toLowerCase();
    for (let len = 1; len <= label.length; len++) {
        const prefix = label.slice(0, len);
        if (prefix.endsWith(" ")) {
            continue;
        }
        const sections = filterPalette(entries, prefix, {}, order);
        const flat = flattenSections(sections);
        const index = bestMatchIndex(sections, prefix);
        if (index >= 0 && flat[index]?.id === entry.id) {
            return prefix;
        }
    }
    return null;
}
