// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The new view chooser (FR-SHELL-089, DS-SHELL-128): a new view opens the panel launcher with 2 to 4 favourite choices
// on top, or one type directly when the developer chose so. The rules (which choices exist, the favourites, what a new
// view starts with, the keys of the chooser) as pure functions, tested without the app; new-view.ts carries them out.

import { fillsPanel, PaletteEntry, PaletteKey, PaletteRun } from "../palette/palette-model";
import { actionEntries, agentEntries, panelEntries } from "../palette/palette-sources";

export const NewViewOpenKey = "app:newviewopen";
export const NewViewFavoritesKey = "app:newviewfavorites";

// On the launcher block of a new view: it shows the chooser, and Escape closes the view.
export const NewViewMetaKey = "molten:newview";
// On the launcher block of a new view opened directly on an entry that needs the launcher to start (an agent types
// its command once the shell runs): the entry's id, run as soon as the block shows.
export const NewViewRunMetaKey = "molten:newview:run";

export const TerminalChoiceId = "panel:defwidget@terminal";
export const WebPageChoiceId = "panel:defwidget@web";
export const DefaultFavoriteIds = [TerminalChoiceId, WebPageChoiceId];
export const MinFavorites = 2;
export const MaxFavorites = 4;

// Actions a new view may hold or run besides the panels and the agents (FR-SHELL-089).
const ChoiceActionIds = ["action:sessions", "action:projecttab"];

export type NewViewChoiceInput = {
    presets: { [key: string]: MetaType };
    widgets: { [key: string]: WidgetConfigType };
    workspaceId: string;
    projectLinked?: boolean;
};

// The launcher entries a new view can open: every panel, every agent preset MoltenTerm knows (never a hard-coded
// provider), Sessions and the Project tab.
export function newViewChoices(input: NewViewChoiceInput): PaletteEntry[] {
    const actions = actionEntries([], input.projectLinked ?? false).filter((e) => ChoiceActionIds.includes(e.id));
    return [...panelEntries(input.widgets, input.workspaceId), ...agentEntries(input.presets), ...actions];
}

function idList(setting: unknown): string[] {
    if (!Array.isArray(setting)) {
        return [];
    }
    const rtn: string[] = [];
    for (const v of setting) {
        if (typeof v === "string" && v.trim() !== "" && !rtn.includes(v.trim())) {
            rtn.push(v.trim());
        }
    }
    return rtn;
}

// The favourite ids as stored, cleaned: unknown ones kept (an agent preset may come back), at most 4, and the defaults
// filling up to 2.
export function favoriteIds(setting: unknown): string[] {
    const rtn = idList(setting).slice(0, MaxFavorites);
    for (const id of DefaultFavoriteIds) {
        if (rtn.length >= MinFavorites) {
            break;
        }
        if (!rtn.includes(id)) {
            rtn.push(id);
        }
    }
    return rtn;
}

// The favourites editor's changes (Settings › General › New views): each returns the list to store, 2 to 4 ids.
export function replaceFavorite(ids: string[], index: number, id: string): string[] {
    if (!id || ids.some((x, i) => x === id && i !== index)) {
        return ids;
    }
    return ids.map((x, i) => (i === index ? id : x));
}

export function moveFavorite(ids: string[], index: number, delta: number): string[] {
    const to = index + delta;
    if (to < 0 || to >= ids.length) {
        return ids;
    }
    const rtn = [...ids];
    [rtn[index], rtn[to]] = [rtn[to], rtn[index]];
    return rtn;
}

export function removeFavorite(ids: string[], index: number): string[] {
    if (ids.length <= MinFavorites) {
        return ids;
    }
    return ids.filter((_, i) => i !== index);
}

export function addFavorite(ids: string[], id: string): string[] {
    if (ids.length >= MaxFavorites || !id || ids.includes(id)) {
        return ids;
    }
    return [...ids, id];
}

// The favourites the chooser shows, in order: the known ones, the defaults filling up to 2.
export function resolveFavorites(setting: unknown, choices: PaletteEntry[]): PaletteEntry[] {
    const byId = new Map((choices ?? []).map((c) => [c.id, c]));
    const rtn = idList(setting)
        .map((id) => byId.get(id))
        .filter((c) => c != null)
        .slice(0, MaxFavorites);
    for (const id of DefaultFavoriteIds) {
        if (rtn.length >= MinFavorites) {
            break;
        }
        const c = byId.get(id);
        if (c != null && !rtn.includes(c)) {
            rtn.push(c);
        }
    }
    return rtn;
}

// The entry a new view opens directly, or null to ask (unset, or an id no launcher entry has).
export function resolveDirect(setting: unknown, choices: PaletteEntry[]): PaletteEntry {
    if (typeof setting !== "string" || setting.trim() === "") {
        return null;
    }
    return (choices ?? []).find((c) => c.id === setting.trim()) ?? null;
}

export const ChooserBlockDef: BlockDef = { meta: { view: "launcher", [NewViewMetaKey]: true } as MetaType };

// What a new view starts with: a tab holding a block, or an action run without a tab (Sessions, the Project tab).
export type NewViewStart = { kind: "tab"; blockdef: BlockDef } | { kind: "run"; run: PaletteRun };

export function newViewStart(entry: PaletteEntry): NewViewStart {
    if (entry == null) {
        return { kind: "tab", blockdef: ChooserBlockDef };
    }
    if (entry.run.kind === "widget") {
        return { kind: "tab", blockdef: entry.run.blockdef };
    }
    if (fillsPanel(entry.run)) {
        return {
            kind: "tab",
            blockdef: { meta: { view: "launcher", [NewViewMetaKey]: true, [NewViewRunMetaKey]: entry.id } as MetaType },
        };
    }
    return { kind: "run", run: entry.run };
}

// The chooser's keyboard (DS-SHELL-128). fav is the selected favourite, -1 while the selection is in the list.
export type ChooserState = { fav: number; favCount: number; selected: number; listCount: number; query: string };

export type ChooserAction =
    | { kind: "fav"; index: number }
    | { kind: "list"; index: number }
    | { kind: "openfav"; index: number }
    | { kind: "cancel" }
    // Swallowed: Tab opens nothing to the right in a new view.
    | { kind: "ignore" };

// null: the palette's own keys apply (the list, typing).
export function chooserKey(state: ChooserState, e: PaletteKey): ChooserAction {
    const plain = !e.ctrl && !e.meta && !e.alt;
    if (!plain) {
        return null;
    }
    if (e.key === "Escape" && !e.shift) {
        return { kind: "cancel" };
    }
    const typing = (state.query ?? "").trim() !== "";
    if (state.fav >= 0 && !typing && state.favCount > 0) {
        const n = state.favCount;
        if ((e.key === "ArrowRight" && !e.shift) || (e.key === "Tab" && !e.shift)) {
            return { kind: "fav", index: (state.fav + 1) % n };
        }
        if ((e.key === "ArrowLeft" && !e.shift) || (e.key === "Tab" && e.shift)) {
            return { kind: "fav", index: (state.fav - 1 + n) % n };
        }
        if (e.key === "Enter" && !e.shift) {
            return { kind: "openfav", index: state.fav };
        }
        if (e.key === "ArrowDown" && !e.shift) {
            return state.listCount > 0 ? { kind: "list", index: 0 } : { kind: "ignore" };
        }
        if (e.key === "ArrowUp" && !e.shift) {
            return { kind: "ignore" };
        }
        return null;
    }
    if (e.key === "Tab") {
        return { kind: "ignore" };
    }
    if (e.key === "ArrowUp" && !e.shift && !typing && state.selected <= 0 && state.favCount > 0) {
        return { kind: "fav", index: 0 };
    }
    return null;
}
