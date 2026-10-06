// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BuiltinProjectCards } from "./project-builtin-cards";
import { layoutProjectCards } from "./project-cards";

// The Project overview's slots (FR-MC-020-AC1, DS-MC-012): the header band, the line map, then four cards in order.
describe("project overview", () => {
    const layout = layoutProjectCards(BuiltinProjectCards);

    it("puts the actions in the header and the branches on the line map", () => {
        expect(layout.header.map((c) => c.id)).toEqual(["moltenterm:next-station"]);
        expect(layout.map.map((c) => c.id)).toEqual(["moltenterm:linemap"]);
    });

    it("shows four cards in one row: Next public release, Releases, Now, Project steps", () => {
        expect(layout.cards.map((c) => c.title)).toEqual(["Next public release", "Releases", "Now", "Project steps"]);
    });

    it("gives each piece of information one card", () => {
        const ids = BuiltinProjectCards.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const gone of ["moltenterm:branches", "moltenterm:runs", "moltenterm:work", "moltenterm:agents"]) {
            expect(ids).not.toContain(gone);
        }
    });

    it("no longer offers the Timeline in the add-panel launcher", () => {
        const widgets = JSON.parse(readFileSync("pkg/wconfig/defaultconfig/widgets.json", "utf8"));
        const views = Object.values(widgets).map((w: any) => w.blockdef?.meta?.view);
        expect(Object.keys(widgets)).not.toContain("defwidget@timeline");
        expect(views).not.toContain("molten-timeline");
        expect(views).toContain("molten-cicd");
    });
});
