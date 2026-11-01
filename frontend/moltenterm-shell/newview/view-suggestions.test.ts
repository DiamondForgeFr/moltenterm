// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The ready-made combinations as the new-view launcher's Suggestions (FR-SHELL-138, TC-SHELL-250, TC-SHELL-251).

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { filterPalette, flattenSections, PaletteGroupOrder } from "../palette/palette-model";
import { suggestionConfig, ViewSuggestions } from "../workspace-views/view-suggestions";
import { chooserKey, suggestionEntries } from "./new-view-model";

function lookup(dict: any): (key: string) => string {
    return (key) => key.split(".").reduce((o, k) => o?.[k], dict) ?? key;
}

describe("the launcher's Suggestions (FR-SHELL-138)", () => {
    it("lists Scoping, Control room, Preview, Code and Delivery, in French too", () => {
        expect(suggestionEntries(lookup(en)).map((e) => e.label)).toEqual([
            "Scoping",
            "Control room",
            "Preview",
            "Code",
            "Delivery",
        ]);
        expect(suggestionEntries(lookup(fr)).map((e) => e.label)).toEqual([
            "Cadrage",
            "Pilotage",
            "Aperçu",
            "Code",
            "Livraison",
        ]);
    });

    it("shows each one's panels, icons and labels, which the search matches", () => {
        const entries = suggestionEntries(lookup(en));
        expect(entries[0]).toMatchObject({
            group: "suggestions",
            detail: "Agent · Web page · Files",
            panelIcons: ["robot", "globe", "folder-open"],
            run: { kind: "suggestion", id: "scoping" },
        });
        const found = flattenSections(filterPalette(entries, "files", {}, PaletteGroupOrder)).map((e) => e.id);
        expect(found).toEqual(["suggestion:scoping", "suggestion:code"]);
    });

    it("comes first in the chooser's list, so ↓ from the favourites reaches it", () => {
        expect(PaletteGroupOrder[0]).toBe("suggestions");
        const state = { fav: 0, favCount: 2, selected: 0, listCount: 7, query: "" };
        expect(chooserKey(state, { key: "ArrowDown", shift: false, ctrl: false, meta: false, alt: false })).toEqual({
            kind: "list",
            index: 0,
        });
    });

    it("lays a view out agent left and graphics right, the agent waiting for a click", () => {
        const scoping = suggestionConfig(ViewSuggestions[0].panels);
        expect(scoping.panes.map((p) => p.view)).toEqual(["term", "molten-browser", "preview"]);
        expect(scoping.panes[0]).toEqual({ view: "term", controller: "shell", "molten:agentslot": true });
        expect(scoping.tree).toEqual({ dir: "row", children: [{ pane: 0 }, { dir: "column", children: [{ pane: 1 }, { pane: 2 }] }] });
        const pilotage = suggestionConfig(ViewSuggestions[1].panels);
        expect(pilotage.tree).toEqual({ dir: "row", children: [{ pane: 0 }, { pane: 1 }] });
        expect(suggestionConfig(["agent"], "codex").panes[0]["molten:slotagent"]).toBe("codex");
        expect(suggestionConfig(["nope"])).toBeNull();
    });
});
