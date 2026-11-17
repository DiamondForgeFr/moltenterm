// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BuiltinProjectCards } from "./project-builtin-cards";
import { layoutProjectCards, shownProjectCards } from "./project-cards";

// The Project overview's slots (FR-MC-020-AC1, DS-MC-012): the header band, the line map, then four cards in order.
describe("project overview", () => {
    const layout = layoutProjectCards(BuiltinProjectCards);

    it("puts the group strip above the actions in the header and the branches on the line map", () => {
        expect(layout.header.map((c) => c.id)).toEqual(["moltenterm:group-strip", "moltenterm:next-station"]);
        expect(layout.map.map((c) => c.id)).toEqual(["moltenterm:linemap"]);
    });

    it("shows four cards in one row: Next public release, Releases, Now, Project steps", () => {
        expect(layout.cards.map((c) => c.title)).toEqual(["Next public release", "Releases", "Now", "Project steps"]);
    });

    it("puts the In progress band between the line map and the cards, and a foot under the row (#2188)", () => {
        expect(layout.band.map((c) => c.id)).toEqual(["moltenterm:running"]);
        expect(layout.foot.map((c) => c.id)).toEqual(["moltenterm:steps-hint"]);
        expect(layout.band[0].bare).toBe(true);
    });

    it("gives the Project steps card's cell to the others when the pipeline declares no step for it (AC-5)", () => {
        const steps = layout.cards.find((c) => c.id === "moltenterm:steps");
        const pipeline = (section: string) => ({ pipeline: { steps: [{ id: "s", section }] } }) as any;
        expect(steps.visible(pipeline("timeline"))).toBe(true);
        expect(steps.visible(pipeline("cd"))).toBe(false);
        expect(steps.visible({ pipeline: null } as any)).toBe(false);
        const props = { pipeline: { steps: [] } } as any;
        expect(shownProjectCards(layout.cards, props).map((c) => c.id)).toEqual([
            "moltenterm:next-release",
            "moltenterm:releases",
            "moltenterm:now",
        ]);
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
