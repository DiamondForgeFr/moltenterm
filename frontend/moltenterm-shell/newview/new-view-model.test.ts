// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PaletteEntry, PaletteKey } from "../palette/palette-model";
import {
    addFavorite,
    ChooserAction,
    ChooserBlockDef,
    chooserKey,
    chooserListEntries,
    ChooserState,
    DefaultFavoriteIds,
    favoriteIds,
    moveFavorite,
    newViewChoices,
    NewViewMetaKey,
    NewViewRunMetaKey,
    newViewStart,
    removeFavorite,
    replaceFavorite,
    resolveDirect,
    resolveFavorites,
} from "./new-view-model";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

const choices = newViewChoices({ presets: DefaultAgents, widgets: DefaultWidgets, workspaceId: "ws1" });

type Outcome = { opened?: PaletteEntry; cancelled?: boolean; state: ChooserState };

// Drives the chooser's keys as the palette does: the favourites from the settings, the list below them.
function press(keys: (string | PaletteKey)[], favoritesSetting?: unknown, listCount = 12): Outcome {
    const favorites = resolveFavorites(favoritesSetting, choices);
    const state: ChooserState = { fav: 0, favCount: favorites.length, selected: 0, listCount, query: "" };
    for (const k of keys) {
        const key: PaletteKey = typeof k === "string" ? { key: k } : k;
        const action: ChooserAction = chooserKey(state, key);
        if (action == null) {
            if (key.key === "ArrowDown") {
                state.selected = Math.min(state.selected + 1, listCount - 1);
            } else if (key.key === "ArrowUp") {
                state.selected = Math.max(state.selected - 1, 0);
            }
            continue;
        }
        switch (action.kind) {
            case "fav":
                state.fav = action.index;
                break;
            case "list":
                state.fav = -1;
                state.selected = action.index;
                break;
            case "openfav":
                return { opened: favorites[action.index], state };
            case "cancel":
                return { cancelled: true, state };
        }
    }
    return { state };
}

function viewOf(entry: PaletteEntry): string {
    const start = newViewStart(entry);
    return start.kind === "tab" ? (start.blockdef.meta.view as string) : start.run.kind;
}

describe("a new view asks by default (FR-SHELL-089, TC-SHELL-166)", () => {
    it("starts with the chooser when nothing is chosen, or an unknown entry is", () => {
        expect(newViewStart(resolveDirect(undefined, choices))).toEqual({ kind: "tab", blockdef: ChooserBlockDef });
        expect(newViewStart(resolveDirect("", choices))).toEqual({ kind: "tab", blockdef: ChooserBlockDef });
        expect(newViewStart(resolveDirect("panel:gone", choices))).toEqual({ kind: "tab", blockdef: ChooserBlockDef });
        expect(ChooserBlockDef.meta.view).toBe("launcher");
        expect((ChooserBlockDef.meta as Record<string, unknown>)[NewViewMetaKey]).toBe(true);
    });

    it("shows Terminal then Web page as the favourites", () => {
        expect(resolveFavorites(undefined, choices).map((e) => e.label)).toEqual(["Terminal", "Web page"]);
    });

    it("opens a terminal on ⌘T then Enter", () => {
        const { opened } = press(["Enter"]);
        expect(opened.run).toEqual({ kind: "widget", blockdef: expect.anything() });
        expect(viewOf(opened)).toBe("term");
    });

    it("opens a web page on ⌘T, → then Enter, and Tab moves the same way", () => {
        expect(viewOf(press(["ArrowRight", "Enter"]).opened)).toBe("molten-browser");
        expect(viewOf(press(["Tab", "Enter"]).opened)).toBe("molten-browser");
        expect(viewOf(press(["ArrowRight", "ArrowLeft", "Enter"]).opened)).toBe("term");
        expect(viewOf(press([{ key: "Tab", shift: true }, "Enter"]).opened)).toBe("molten-browser");
    });

    it("reaches the full list with ↓, and ↑ from its first row goes back to the favourites", () => {
        const down = press(["ArrowDown"]);
        expect(down.state.fav).toBe(-1);
        expect(down.state.selected).toBe(0);
        expect(press(["ArrowDown", "ArrowDown"]).state.selected).toBe(1);
        expect(press(["ArrowDown", "ArrowUp"]).state.fav).toBe(0);
        expect(chooserKey({ fav: -1, favCount: 2, selected: 0, listCount: 3, query: "" }, { key: "Enter" })).toBeNull();
    });

    it("cancels the new view on Escape, from the favourites or the list", () => {
        expect(press(["Escape"]).cancelled).toBe(true);
        expect(press(["ArrowDown", "Escape"]).cancelled).toBe(true);
    });

    it("leaves typed text to the palette (addresses, filtering), and never opens to the right", () => {
        const typing: ChooserState = { fav: -1, favCount: 2, selected: 0, listCount: 3, query: "github.com" };
        expect(chooserKey(typing, { key: "Enter" })).toBeNull();
        expect(chooserKey(typing, { key: "ArrowLeft" })).toBeNull();
        expect(chooserKey(typing, { key: "Tab" })).toEqual({ kind: "ignore" });
        expect(chooserKey(typing, { key: "ArrowUp" })).toBeNull();
    });
});

describe("opening one type directly (FR-SHELL-089, TC-SHELL-167)", () => {
    it("skips the chooser with the type chosen", () => {
        expect(newViewStart(resolveDirect("panel:defwidget@terminal", choices))).toEqual({
            kind: "tab",
            blockdef: DefaultWidgets["defwidget@terminal"].blockdef,
        });
        expect(viewOf(resolveDirect("panel:defwidget@web", choices))).toBe("molten-browser");
    });

    it("starts an agent through the launcher, which runs it at once", () => {
        const start = newViewStart(resolveDirect("agent:codex", choices));
        expect(start.kind).toBe("tab");
        const meta = (start as { blockdef: BlockDef }).blockdef.meta as Record<string, unknown>;
        expect(meta.view).toBe("launcher");
        expect(meta[NewViewRunMetaKey]).toBe("agent:codex");
    });

    it("runs an action that holds no panel without a tab", () => {
        const linked = newViewChoices({
            presets: DefaultAgents,
            widgets: DefaultWidgets,
            workspaceId: "ws1",
            projectLinked: true,
        });
        expect(newViewStart(resolveDirect("action:projecttab", linked))).toEqual({
            kind: "run",
            run: { kind: "projecttab" },
        });
    });

    it("opens the Sessions panel for a choice saved when Sessions was an action (#1273)", () => {
        const start = newViewStart(resolveDirect("action:sessions", choices));
        expect(start.kind).toBe("tab");
        expect((start as { blockdef: BlockDef }).blockdef.meta.view).toBe("molten-sessions");
        expect(resolveFavorites(["action:sessions"], choices)[0].id).toBe("panel:sessions");
    });

    it("offers every panel, MoltenTerm's own included, every registered agent, never the launcher itself", () => {
        const ids = choices.map((c) => c.id);
        expect(ids).toEqual(expect.arrayContaining(["panel:defwidget@terminal", "panel:defwidget@web"]));
        expect(ids).toEqual(expect.arrayContaining(["panel:missioncontrol", "panel:linemap", "panel:sessions"]));
        expect(ids).not.toContain("action:sessions");
        expect(ids).toEqual(expect.arrayContaining(["agent:claude", "agent:codex"]));
        const custom = newViewChoices({
            presets: { "agent@aider": { "agent:command": "aider" } } as any,
            widgets: DefaultWidgets,
            workspaceId: "ws1",
        });
        expect(custom.map((c) => c.id)).toContain("agent:aider");
        expect(custom.map((c) => c.id)).not.toContain("agent:claude");
        expect(choices.some((c) => c.run.kind === "widget" && c.run.blockdef?.meta?.view === "launcher")).toBe(false);
    });
});

describe("favourites (FR-SHELL-089)", () => {
    it("keeps 2 to 4 in their order, the defaults filling up", () => {
        expect(favoriteIds(undefined)).toEqual(DefaultFavoriteIds);
        expect(favoriteIds(["agent:codex"])).toEqual(["agent:codex", "panel:defwidget@terminal"]);
        expect(favoriteIds(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d"]);
        expect(favoriteIds(["a", "a", 3, ""])).toEqual(["a", "panel:defwidget@terminal"]);
        const shown = resolveFavorites(["agent:codex", "panel:gone", "panel:defwidget@files"], choices);
        expect(shown.map((e) => e.id)).toEqual(["agent:codex", "panel:defwidget@files"]);
        expect(resolveFavorites(["panel:gone"], choices).map((e) => e.id)).toEqual(DefaultFavoriteIds);
    });

    it("edits the list without going under 2 or over 4", () => {
        const ids = ["panel:defwidget@terminal", "panel:defwidget@web"];
        expect(removeFavorite(ids, 0)).toEqual(ids);
        const three = addFavorite(ids, "agent:claude");
        expect(three).toEqual([...ids, "agent:claude"]);
        expect(moveFavorite(three, 2, -1)).toEqual(["panel:defwidget@terminal", "agent:claude", "panel:defwidget@web"]);
        expect(moveFavorite(three, 0, -1)).toEqual(three);
        expect(removeFavorite(three, 1)).toEqual(["panel:defwidget@terminal", "agent:claude"]);
        expect(replaceFavorite(three, 0, "panel:defwidget@web")).toEqual(three);
        expect(replaceFavorite(three, 0, "panel:defwidget@files")[0]).toBe("panel:defwidget@files");
        const four = addFavorite(three, "agent:codex");
        expect(addFavorite(four, "panel:defwidget@files")).toEqual(four);
    });

    it("show the stored favourites first in the chooser", () => {
        const { opened } = press(["Enter"], ["agent:claude", "panel:defwidget@terminal", "panel:defwidget@web"]);
        expect(opened.id).toBe("agent:claude");
        expect(
            press(["ArrowLeft", "Enter"], ["agent:claude", "panel:defwidget@terminal", "panel:defwidget@web"]).opened.id
        ).toBe("panel:defwidget@web");
    });
});

describe("the chooser list (#1238)", () => {
    it("leaves out New tab, which only opened another new view", () => {
        const entries = [{ id: "action:newtab" }, { id: "action:sessions" }] as PaletteEntry[];
        expect(chooserListEntries(entries).map((e) => e.id)).toEqual(["action:sessions"]);
    });
});
