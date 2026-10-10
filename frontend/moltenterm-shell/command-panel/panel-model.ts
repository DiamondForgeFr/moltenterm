// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The command panel's rules as pure functions (FR-SHELL-047, DS-SHELL-085): which rows a page shows, how search
// reaches every section and sub-page, the Developer gate behind Option, the keyboard and the scopes of an option.
// Matching reuses the command palette's fuzzy matcher; command-panel.tsx only renders.

import { fuzzyMatch, moveSelection, PaletteKey, paletteKeyCommand } from "../palette/palette-model";
import {
    PanelChoice,
    PanelChoiceOption,
    PanelItem,
    PanelNumber,
    PanelScopeId,
    PanelScopeOrder,
    PanelSection,
    ScopeBinding,
} from "./panel-types";

export const PanelWidthPx = 360;
export const PanelMaxHeightPx = 560;
export const FooterSectionTitle = "Panel";

export type PanelRow =
    | { kind: "heading"; key: string; title: string; state?: string; stateTone?: "warning" | "muted" }
    | { kind: "item"; key: string; item: PanelItem; path: string[]; breadcrumb?: string; indices?: number[] }
    | {
          kind: "option";
          key: string;
          choice: PanelChoice;
          option: PanelChoiceOption;
          path: string[];
          breadcrumb?: string;
          indices?: number[];
      };

export type PanelRowsInput = {
    sections: PanelSection[];
    // The ids of the sub-pages opened from the root, innermost last.
    stack: string[];
    query: string;
    // Option (Alt) held: the Developer section shows.
    alt: boolean;
    // The footer's block actions: never listed, but search finds them.
    footer?: PanelItem[];
};

export function isSelectableRow(row: PanelRow): boolean {
    if (row.kind === "heading") {
        return false;
    }
    if (row.kind === "option") {
        return !row.option.disabled;
    }
    return row.item.type !== "info" && !row.item.disabled;
}

function isWordStart(text: string, index: number): boolean {
    if (index === 0) {
        return true;
    }
    const prev = text[index - 1];
    const cur = text[index];
    if (/[\s\-_./\\:@()›]/.test(prev)) {
        return true;
    }
    return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

// Stricter than the palette: the panel holds dozens of short labels, where a loose subsequence ("font" in "Force
// restart controller") is noise. A match counts when the query is a substring of the text, or when every run of
// matched characters starts a word ("fs" → "Font size", "cc" → "Claude Code").
export function panelMatch(query: string, text: string): { score: number; indices: number[] } {
    const q = (query ?? "").trim().toLowerCase();
    if (q === "" || !text) {
        return null;
    }
    const m = fuzzyMatch(q, text);
    if (m == null) {
        return null;
    }
    const at = text.toLowerCase().indexOf(q);
    if (at >= 0) {
        const indices = Array.from({ length: q.length }, (_, i) => at + i).filter((i) => text[i] !== " ");
        return { score: Math.max(m.score, q.length * 2 + (at === 0 ? 8 : 0)), indices };
    }
    for (let i = 0; i < m.indices.length; i++) {
        const runStart = i === 0 || m.indices[i] !== m.indices[i - 1] + 1;
        if (runStart && !isWordStart(text, m.indices[i])) {
            return null;
        }
    }
    return m;
}

const SecondaryWeight = 0.5;

function matchTexts(query: string, label: string, secondary: string[]): { score: number; indices: number[] } {
    const main = panelMatch(query, label);
    let best = main;
    for (const text of secondary) {
        const m = panelMatch(query, text);
        if (m == null) {
            continue;
        }
        const weighted = m.score * SecondaryWeight;
        if (best == null || weighted > best.score) {
            best = { score: weighted, indices: main?.indices ?? [] };
        }
    }
    return best;
}

// Developer items stay behind Option, in search too, so a click or an Enter cannot restart a controller by accident
// (FR-SHELL-047 security rationale).
export function visibleSections(sections: PanelSection[], alt: boolean): PanelSection[] {
    return (sections ?? []).filter((s) => s.kind !== "developer" || alt);
}

// The item a stack of ids leads to (a choice or a page), or null when one of them is gone (the panel changed).
export function findPage(sections: PanelSection[], stack: string[]): PanelItem {
    let items: PanelItem[] = (sections ?? []).flatMap((s) => s.items);
    let found: PanelItem = null;
    for (const id of stack ?? []) {
        found = items.find((it) => it.id === id) ?? null;
        if (found == null) {
            return null;
        }
        items = found.type === "page" ? found.items : [];
    }
    return found;
}

// The ids of the pages that still exist, from the root (a stale stack falls back to its valid start).
export function validStack(sections: PanelSection[], stack: string[]): string[] {
    const kept: string[] = [];
    for (const id of stack ?? []) {
        const page = findPage(sections, [...kept, id]);
        if (page == null || (page.type !== "page" && page.type !== "choice")) {
            break;
        }
        kept.push(id);
    }
    return kept;
}

type Hit = { row: PanelRow; score: number; order: number };

function searchItems(query: string, items: PanelItem[], path: string[], breadcrumb: string, hits: Hit[]) {
    for (const item of items) {
        const m = matchTexts(
            query,
            item.label,
            [item.detail, ...(item.keywords ?? [])].filter((s) => s)
        );
        if (m != null && item.type !== "info") {
            hits.push({
                row: {
                    kind: "item",
                    key: `s:${[...path, item.id].join("/")}`,
                    item,
                    path,
                    breadcrumb,
                    indices: m.indices,
                },
                score: m.score,
                order: hits.length,
            });
        }
        const inner = [breadcrumb, item.label].filter((s) => s).join(" › ");
        if (item.type === "choice") {
            for (const option of item.options) {
                let om = matchTexts(
                    query,
                    option.label,
                    [option.detail].filter((s) => s)
                );
                if (om == null && query.trim().includes(" ")) {
                    const combined = panelMatch(query, `${item.label} ${option.label}`);
                    om = combined == null ? null : { score: combined.score * SecondaryWeight, indices: [] };
                }
                if (om == null) {
                    continue;
                }
                hits.push({
                    row: {
                        kind: "option",
                        key: `o:${[...path, item.id, option.id].join("/")}`,
                        choice: item,
                        option,
                        path: [...path, item.id],
                        breadcrumb: inner,
                        indices: om.indices,
                    },
                    score: om.score,
                    order: hits.length,
                });
            }
        }
        if (item.type === "page") {
            searchItems(query, item.items, [...path, item.id], inner, hits);
        }
    }
}

function sortedHits(hits: Hit[]): PanelRow[] {
    return hits.sort((a, b) => b.score - a.score || a.order - b.order).map((h) => h.row);
}

function itemRows(items: PanelItem[], path: string[], keyPrefix: string): PanelRow[] {
    return items.map((item) => ({ kind: "item", key: `${keyPrefix}${item.id}`, item, path }) as PanelRow);
}

// The rows a page shows: the root's sections with headings, a sub-page's items or options, or search results grouped
// by section (in the sections' fixed order, best match first inside each).
export function buildRows(input: PanelRowsInput): PanelRow[] {
    const query = (input.query ?? "").trim();
    const stack = validStack(input.sections, input.stack);
    const rows: PanelRow[] = [];
    if (stack.length > 0) {
        const page = findPage(input.sections, stack);
        if (query === "") {
            if (page.type === "choice") {
                return page.options.map((option) => ({
                    kind: "option",
                    key: `o:${option.id}`,
                    choice: page,
                    option,
                    path: stack,
                }));
            }
            return itemRows((page as any).items ?? [], stack, "p:");
        }
        if (page.type === "choice") {
            const hits: Hit[] = [];
            page.options.forEach((option) => {
                const m = matchTexts(
                    query,
                    option.label,
                    [option.detail].filter((s) => s)
                );
                if (m != null) {
                    hits.push({
                        row: {
                            kind: "option",
                            key: `o:${option.id}`,
                            choice: page,
                            option,
                            path: stack,
                            indices: m.indices,
                        },
                        score: m.score,
                        order: hits.length,
                    });
                }
            });
            return sortedHits(hits);
        }
        const hits: Hit[] = [];
        searchItems(query, (page as any).items ?? [], stack, "", hits);
        return sortedHits(hits);
    }
    const sections = visibleSections(input.sections, input.alt);
    if (query === "") {
        for (const section of sections) {
            rows.push({
                kind: "heading",
                key: `h:${section.id}`,
                title: section.title,
                state: section.state,
                stateTone: section.stateTone,
            });
            rows.push(...itemRows(section.items, [], `i:${section.id}:`));
        }
        return rows;
    }
    const groups: { id: string; title: string; state?: string; stateTone?: any; items: PanelItem[] }[] = [...sections];
    if (input.footer?.length) {
        groups.push({ id: "footer", title: FooterSectionTitle, items: input.footer });
    }
    for (const group of groups) {
        const hits: Hit[] = [];
        searchItems(query, group.items, [], "", hits);
        if (hits.length === 0) {
            continue;
        }
        rows.push({
            kind: "heading",
            key: `h:${group.id}`,
            title: group.title,
            state: group.state,
            stateTone: group.stateTone,
        });
        rows.push(...sortedHits(hits));
    }
    return rows;
}

export function selectableIndices(rows: PanelRow[]): number[] {
    const rtn: number[] = [];
    rows.forEach((row, i) => {
        if (isSelectableRow(row)) {
            rtn.push(i);
        }
    });
    return rtn;
}

// The selection moves over selectable rows only and wraps (the palette's rule).
export function moveRowSelection(rows: PanelRow[], current: number, command: "up" | "down" | "first" | "last"): number {
    const selectable = selectableIndices(rows);
    if (selectable.length === 0) {
        return -1;
    }
    const pos = selectable.indexOf(current);
    if (pos < 0) {
        return command === "up" || command === "last" ? selectable[selectable.length - 1] : selectable[0];
    }
    return selectable[moveSelection(pos, command, selectable.length)];
}

export function firstSelectable(rows: PanelRow[]): number {
    const selectable = selectableIndices(rows);
    return selectable.length > 0 ? selectable[0] : -1;
}

// The row Cmd+N runs: the Nth selectable row from the top (FR-SHELL-047-AC3).
// A destructive row is never numbered: it runs only by a deliberate Enter or click.
export function isDestructiveRow(row: PanelRow): boolean {
    return row?.kind === "item" && !!row.item.destructive;
}

export function numberedIndices(rows: PanelRow[]): number[] {
    return selectableIndices(rows).filter((i) => !isDestructiveRow(rows[i]));
}

export function nthSelectable(rows: PanelRow[], n: number): number {
    const numbered = numberedIndices(rows);
    return n >= 1 && n <= numbered.length ? numbered[n - 1] : -1;
}

export type PanelKeyIntent =
    | { type: "move"; command: "up" | "down" | "first" | "last" }
    | { type: "activate" }
    | { type: "activate-nth"; n: number }
    | { type: "open" }
    | { type: "back" }
    | { type: "step"; delta: number }
    | { type: "clear-query" }
    | { type: "close" };

export type PanelKeyState = { query: string; depth: number; row: PanelRow };

function rowItemType(row: PanelRow): string {
    if (row == null || row.kind === "heading") {
        return null;
    }
    return row.kind === "option" ? "option" : row.item.type;
}

// The keyboard model (DS-SHELL-085, NFR-SHELL-026): arrows choose, Enter runs, → opens a sub-page or steps a number
// up, ← steps it down or goes back, Backspace on an empty search goes back, Esc clears the search, then goes back,
// then closes; Cmd+1..9 run the first nine rows. ← and → only act while the search is empty (else they move the
// caret).
export function panelKeyIntent(e: PaletteKey, state: PanelKeyState): PanelKeyIntent {
    const plain = !e.shift && !e.ctrl && !e.meta && !e.alt;
    const empty = (state.query ?? "") === "";
    if ((e.meta || e.ctrl) && !e.shift && !e.alt && /^[1-9]$/.test(e.key)) {
        return { type: "activate-nth", n: Number(e.key) };
    }
    if (e.key === "Escape" && plain) {
        if (!empty) {
            return { type: "clear-query" };
        }
        return state.depth > 0 ? { type: "back" } : { type: "close" };
    }
    const type = rowItemType(state.row);
    if (e.key === "ArrowRight" && plain && empty) {
        if (type === "choice" || type === "page") {
            return { type: "open" };
        }
        if (type === "number") {
            return { type: "step", delta: 1 };
        }
        return null;
    }
    if (e.key === "ArrowLeft" && plain && empty) {
        if (type === "number") {
            return { type: "step", delta: -1 };
        }
        return state.depth > 0 ? { type: "back" } : null;
    }
    if (e.key === "Backspace" && plain && empty && state.depth > 0) {
        return { type: "back" };
    }
    const command = paletteKeyCommand(e);
    if (command === "up" || command === "down" || command === "first" || command === "last") {
        return { type: "move", command };
    }
    if (command === "open") {
        return { type: "activate" };
    }
    return null;
}

// --- Scopes (FR-SHELL-047-AC5, DS-SHELL-086)

type Scoped<T> = { scopes?: ScopeBinding<T>[]; defaultValue?: T; value?: T };

function sortedScopes<T>(scopes: ScopeBinding<T>[]): ScopeBinding<T>[] {
    return [...(scopes ?? [])].sort((a, b) => PanelScopeOrder.indexOf(a.scope) - PanelScopeOrder.indexOf(b.scope));
}

function safeGet<T>(binding: ScopeBinding<T>): T | undefined {
    try {
        return binding.get();
    } catch {
        return undefined;
    }
}

export function isSetAt<T>(binding: ScopeBinding<T>): boolean {
    return binding != null && safeGet(binding) !== undefined;
}

// The value in effect: the narrowest scope that holds one, else the default; a plain item keeps its own value.
export function effectiveValue<T>(item: Scoped<T>): T {
    if (!item.scopes?.length) {
        return item.value ?? item.defaultValue;
    }
    for (const binding of sortedScopes(item.scopes)) {
        const v = safeGet(binding);
        if (v !== undefined) {
            return v;
        }
    }
    return item.defaultValue;
}

// The scope an edit goes to: the one chosen in the sub-page, else the narrowest that holds a value, else the
// provider's first (its preferred scope).
export function activeScope<T>(item: Scoped<T>, chosen?: PanelScopeId): ScopeBinding<T> {
    const scopes = item.scopes ?? [];
    if (scopes.length === 0) {
        return null;
    }
    if (chosen != null) {
        const picked = scopes.find((b) => b.scope === chosen);
        if (picked != null) {
            return picked;
        }
    }
    return sortedScopes(scopes).find((b) => isSetAt(b)) ?? scopes[0];
}

// The value shown while editing a scope: what that scope holds, else what it inherits.
export function valueAtScope<T>(item: Scoped<T>, binding: ScopeBinding<T>): T {
    if (binding == null) {
        return effectiveValue(item);
    }
    const own = safeGet(binding);
    if (own !== undefined) {
        return own;
    }
    const wider = sortedScopes(item.scopes).filter(
        (b) => PanelScopeOrder.indexOf(b.scope) > PanelScopeOrder.indexOf(binding.scope)
    );
    for (const b of wider) {
        const v = safeGet(b);
        if (v !== undefined) {
            return v;
        }
    }
    return item.defaultValue;
}

export function scopeLabel(scope: PanelScopeId, kindLabel: string): string {
    switch (scope) {
        case "panel":
            return "This panel";
        case "project":
            return "This project";
        case "workspace":
            return "This workspace";
        case "kind":
            return kindLabel ? `All ${kindLabel}` : "All panels of this kind";
        case "global":
            return "Everywhere";
    }
    return "";
}

function sameValue(a: unknown, b: unknown): boolean {
    return a === b || (a != null && b != null && JSON.stringify(a) === JSON.stringify(b));
}

export function optionSelected(choice: PanelChoice, option: PanelChoiceOption, chosen?: PanelScopeId): boolean {
    if (option.checked != null && !choice.scopes?.length && choice.value === undefined) {
        return option.checked;
    }
    const binding = activeScope(choice, chosen);
    const value = binding != null ? valueAtScope(choice, binding) : effectiveValue(choice);
    return sameValue(value, option.value);
}

export function choiceValueLabel(choice: PanelChoice): string {
    const selected = choice.options.find((o) => optionSelected(choice, o));
    return selected?.label ?? "";
}

export function stepNumber(item: PanelNumber, value: number, delta: number): number {
    const current = Number.isFinite(value) ? value : (item.defaultValue ?? item.min);
    const raw = current + delta * item.step;
    const decimals = (String(item.step).split(".")[1] ?? "").length;
    const snapped = Number(raw.toFixed(decimals));
    return Math.min(item.max, Math.max(item.min, snapped));
}

// Writes a value at the active scope, or through the item's own setter.
export async function setItemValue<T>(
    item: Scoped<T> & { set?: (v: T) => void | Promise<void> },
    value: T,
    chosen?: PanelScopeId
) {
    const binding = activeScope(item, chosen);
    if (binding != null) {
        await binding.set(value);
        return;
    }
    await item.set?.(value);
}

export async function resetItem<T>(item: Scoped<T>, chosen?: PanelScopeId) {
    const binding = activeScope(item, chosen);
    if (binding == null || !isSetAt(binding)) {
        return;
    }
    await binding.clear();
}

export function canReset<T>(item: Scoped<T>, chosen?: PanelScopeId): boolean {
    return isSetAt(activeScope(item, chosen));
}

// Every runnable entry of a panel, flattened, for the command palette (the panel's actions are palette commands).
export type FlatPanelEntry = {
    id: string;
    label: string;
    breadcrumb: string;
    icon?: string;
    shortcut?: string;
    item: PanelItem;
    option?: PanelChoiceOption;
};

export function flattenPanel(sections: PanelSection[], footer: PanelItem[] = []): FlatPanelEntry[] {
    const rtn: FlatPanelEntry[] = [];
    const walk = (items: PanelItem[], crumbs: string[]) => {
        for (const item of items) {
            const breadcrumb = crumbs.join(" › ");
            if (item.disabled || item.type === "info") {
                continue;
            }
            // A number has no single value to run: its palette entry opens the panel on it.
            if (item.type === "action" || item.type === "toggle" || item.type === "number") {
                rtn.push({
                    id: item.id,
                    label: item.label,
                    breadcrumb,
                    icon: item.icon,
                    shortcut: item.shortcut,
                    item,
                });
            } else if (item.type === "choice") {
                for (const option of item.options) {
                    if (option.disabled) {
                        continue;
                    }
                    rtn.push({
                        id: `${item.id}/${option.id}`,
                        label: `${item.label}: ${option.label}`,
                        breadcrumb,
                        icon: item.icon,
                        item,
                        option,
                    });
                }
            } else if (item.type === "page") {
                walk(item.items, [...crumbs, item.label]);
            }
        }
    };
    // Developer items stay in the panel, behind Option.
    for (const section of (sections ?? []).filter((s) => s.kind !== "developer")) {
        walk(section.items, [section.title]);
    }
    walk(footer, [FooterSectionTitle]);
    return rtn;
}
