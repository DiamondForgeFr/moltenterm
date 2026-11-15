// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The favourites row shows the favourite a web row opens as selected (#2312): the Web page tile in the accent, as when
// the arrows choose it, while the selection itself stays in the list below.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PaletteEntry } from "../palette/palette-model";
import { FavoritesRow } from "./favorites-row";

const Favorites: PaletteEntry[] = [
    { id: "panel:defwidget@terminal", group: "panels", label: "Terminal", icon: "terminal", run: { kind: "newtab" } },
    { id: "panel:defwidget@web", group: "panels", label: "Web page", icon: "globe", run: { kind: "newtab" } },
];

function html(selected: number, target?: number): string {
    return renderToStaticMarkup(
        <FavoritesRow
            favorites={Favorites}
            keys={["⌥⌘1", "⌥⌘2"]}
            selected={selected}
            target={target}
            onHover={() => {}}
            onOpen={() => {}}
        />
    );
}

function tile(markup: string, id: string): string {
    return markup.match(new RegExp(`<div[^>]*data-favorite="${id}"[^>]*>`))?.[0] ?? "";
}

describe("the favourites row", () => {
    it("selects the favourite the arrows chose", () => {
        const markup = html(1);
        expect(tile(markup, "panel:defwidget@web")).toContain('aria-selected="true"');
        expect(tile(markup, "panel:defwidget@terminal")).toContain('aria-selected="false"');
        expect(tile(markup, "panel:defwidget@web")).toContain("border-accent");
    });

    it("shows the target favourite as selected while the selection is in the list", () => {
        const markup = html(-1, 1);
        expect(tile(markup, "panel:defwidget@web")).toContain('aria-selected="true"');
        expect(tile(markup, "panel:defwidget@web")).toContain("data-target");
        expect(tile(markup, "panel:defwidget@web")).toContain("border-accent");
        expect(tile(markup, "panel:defwidget@terminal")).toContain('aria-selected="false"');
        expect(tile(markup, "panel:defwidget@terminal")).not.toContain("border-accent");
    });

    it("shows none selected while the list holds the selection and no favourite is the target", () => {
        const markup = html(-1, -1);
        expect(markup).not.toContain('aria-selected="true"');
        expect(markup).not.toContain("data-target");
    });
});
