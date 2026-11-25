// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atom } from "jotai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { carpetPlacesItems } from "../command-panel/providers/carpet-places";
import { CarpetGroup, GroupAll, GroupPages } from "./carpet-group";
import { placeOptions } from "./carpet-places";
import type { PanelPlacement, View360Model } from "./view360-model";
import { CarpetHeaderButton, headerPlacement } from "./view360-places";
import {
    chooserChoices,
    EvenZonesRow,
    groupPlanLines,
    optionCaption,
    optionsWhy,
    pickPlaceOption,
    PlaceCount,
    placesKeyChoice,
} from "./view360-places-chooser";

const fake = vi.hoisted(() => ({ view360: null as unknown }));

vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: () => ({ moltenView360: fake.view360 }) }));

function setView(active: boolean, roles: Record<string, PanelPlacement>, placements: Record<string, PanelPlacement>) {
    fake.view360 = {
        activeAtom: atom(active),
        rolesAtom: atom(roles),
        placementsAtom: atom(placements),
        placesAtom: atom(null as number),
    };
}

const Roles: Record<string, PanelPlacement> = { agent: "first", page: "carpet", files: "carpet" };

function header(blockId: string): string {
    return renderToStaticMarkup(<CarpetHeaderButton blockId={blockId} />);
}

describe("Store on the carpet, the header button (FR-SHELL-123-AC1)", () => {
    it("shows on a panel outside the fixed zone, in and out of 360 view", () => {
        setView(false, Roles, {});
        const off = header("page");
        expect(off).toContain("mt-carpet-button");
        expect(off).toContain('aria-label="Store on the carpet');
        expect(off).toContain("mt-v360-icon");
        setView(true, Roles, Roles);
        expect(header("page")).toContain("mt-carpet-button");
    });

    it("is absent from the fixed zone and from a view holding one column", () => {
        setView(false, Roles, {});
        expect(header("agent")).toBe("");
        setView(false, { agent: "first" }, {});
        expect(header("agent")).toBe("");
        setView(true, Roles, Roles);
        expect(header("agent")).toBe("");
    });

    it("shows the filled pin with its badge on a pinned panel", () => {
        setView(true, { ...Roles, files: "beside" }, { ...Roles, files: "beside" });
        const html = header("files");
        expect(html).toContain("mt-pinned-badge");
        expect(html).toContain("is-pinned");
        expect(html).not.toContain("mt-carpet-button");
    });

    it("stands where the pin button stood in the Wave header and the browser's, right before the gear", () => {
        const root = resolve(__dirname, "../../..");
        const wave = readFileSync(resolve(root, "frontend/app/block/blockframe-header.tsx"), "utf8");
        expect(wave.indexOf("<CarpetHeaderButton")).toBeGreaterThan(0);
        expect(wave.indexOf("<CarpetHeaderButton")).toBeLessThan(wave.indexOf("const settingsDecl"));
        expect(wave).not.toContain("PinHeaderButton");
        const browser = readFileSync(resolve(root, "frontend/moltenterm-shell/browser/browser-view.tsx"), "utf8");
        expect(browser.indexOf("<CarpetHeaderButton")).toBeGreaterThan(0);
        expect(browser.indexOf("<CarpetHeaderButton")).toBeLessThan(
            browser.indexOf('data-role="command-panel-trigger"')
        );
    });

    it("reads a pin as pinned only where 360 view draws it", () => {
        expect(headerPlacement(false, {}, { a: "first", b: "stacked" }, "b")).toBe("carpet");
        expect(headerPlacement(true, { b: "stacked" }, { b: "stacked" }, "b")).toBe("stacked");
        expect(headerPlacement(false, {}, {}, "b")).toBeNull();
    });
});

describe("the chooser's words (AC2, AC3, AC13)", () => {
    it("captions each number with its share and what it stores, or why it cannot apply", () => {
        const options = placeOptions(4, 1450);
        expect(options.map(optionCaption)).toEqual([
            "Half and half · 3 stored",
            "A third and two thirds · 2 stored",
            "Too narrow on this screen",
        ]);
        expect(optionsWhy(options)).toContain("Close the sidebar or use a wider screen");
        expect(optionsWhy(placeOptions(6, 3160))).toBeNull();
    });
});

// #2549: a developer with two panels on the carpet could not switch to 360 × 2, greyed "Nothing to store".
describe("every layout stays selectable, nothing to store is said (#2549)", () => {
    const two = placeOptions(2, 3160);

    function card(n: number, options = two): string {
        const option = options.find((o) => o.n === n);
        return renderToStaticMarkup(
            <PlaceCount option={option} hover={false} testId={`mt-places-${n}`} onHover={vi.fn()} onApply={vi.fn()} />
        );
    }

    it("offers 360 × 2 and × 3 with two panels, their card saying nothing goes on the carpet", () => {
        expect(two.map(optionCaption)).toEqual([
            "Half and half · 1 stored",
            "All panels visible, nothing on the carpet",
            "All panels visible, nothing on the carpet",
        ]);
        for (const n of [2, 3]) {
            const html = card(n);
            expect(html).toContain('data-offered="true"');
            expect(html).toContain('aria-disabled="false"');
            expect(html).toContain("cursor-pointer");
            expect(html).not.toContain("is-off");
            expect(html).toContain("All panels visible, nothing on the carpet");
        }
        expect(optionsWhy(two)).toBeNull();
    });

    it("applies 1, 2 and 3 from their keys with two panels", () => {
        for (const key of ["1", "2", "3"]) {
            const n = placesKeyChoice({ key });
            expect(n).toBe(Number(key));
            expect(pickPlaceOption(two, n)?.n).toBe(n);
        }
        expect(placesKeyChoice({ key: "2", metaKey: true })).toBeNull();
        expect(placesKeyChoice({ key: "4" })).toBeNull();
    });

    it("keeps a number the screen is too narrow for disabled, with its reason", () => {
        const narrow = placeOptions(2, 1200);
        expect(pickPlaceOption(narrow, 2)).toBeNull();
        expect(pickPlaceOption(narrow, 1)?.n).toBe(1);
        const html = card(2, narrow);
        expect(html).toContain('aria-disabled="true"');
        expect(html).toContain("is-off");
        expect(html).toContain('data-reason="narrow"');
        expect(html).toContain("Too narrow on this screen");
        expect(optionsWhy(narrow)).toContain("Close the sidebar or use a wider screen");
    });

    it("lists 360 × 2 in the command panel with two panels on the carpet", () => {
        const view = {
            activeAtom: atom(false),
            placementsAtom: atom({} as Record<string, PanelPlacement>),
            rolesAtom: atom({ agent: "first", page: "carpet", files: "carpet" } as Record<string, PanelPlacement>),
            shownPlacesAtom: atom(null as number),
            placeOptions: () => two,
            applyPlaces: vi.fn(() => true),
        } as unknown as View360Model;
        const items = carpetPlacesItems(view, "page");
        expect(items.map((i) => i.id)).toEqual(["molten:places:1", "molten:places:2", "molten:places:3"]);
        (items[1] as { run: () => void }).run();
        expect(view.applyPlaces).toHaveBeenCalledWith("page", 2);
    });
});

describe("Even out the zones, where the chooser and the command panel offer it (FR-SHELL-123-AC20, #2433)", () => {
    it("is a row of the chooser, enabled while the zones are uneven", () => {
        const html = renderToStaticMarkup(<EvenZonesRow why={null} onRun={vi.fn()} />);
        expect(html).toContain("Even out the zones");
        expect(html).not.toContain("aria-disabled");
        expect(html).toContain('data-testid="mt-places-even-zones"');
        expect(html).not.toContain("mt-places-even-why");
    });

    it("stays clickable with nothing to do, saying why under it (#2549)", () => {
        const even = renderToStaticMarkup(<EvenZonesRow why="even" onRun={vi.fn()} />);
        expect(even).not.toContain("aria-disabled");
        expect(even).not.toContain("is-off");
        expect(even).toContain("cursor-pointer");
        expect(even).toContain('aria-describedby="mt-places-even-why"');
        expect(even).toContain("The zones already have equal widths");
        const single = renderToStaticMarkup(<EvenZonesRow why="single" onRun={vi.fn()} />);
        expect(single).not.toContain("is-off");
        expect(single).toContain("One zone is in view: there is nothing to even out");
    });

    it("stands in the chooser's Already in 360 view section, after the pins and before Leave", () => {
        const source = readFileSync(resolve(__dirname, "view360-places-chooser.tsx"), "utf8");
        const section = source.indexOf('t("view360.places.already")');
        expect(section).toBeGreaterThan(0);
        expect(source.indexOf("<EvenZonesRow", section)).toBeGreaterThan(
            source.indexOf('data-testid="mt-places-pin-stacked"')
        );
        expect(source.indexOf("<EvenZonesRow", section)).toBeLessThan(source.indexOf('data-testid="mt-places-leave"'));
    });

    // The part of a 360 view the command panel reads, in 360 view with 2 zones drawn.
    function panelView(why: "single" | "even" | null) {
        return {
            activeAtom: atom(true),
            placementsAtom: atom({ page: "carpet" } as Record<string, PanelPlacement>),
            rolesAtom: atom({ page: "carpet" } as Record<string, PanelPlacement>),
            shownPlacesAtom: atom(2),
            placeOptions: () => [],
            evenZonesWhy: () => why,
            evenZones: vi.fn(() => true),
            requestLeave: vi.fn(),
        } as unknown as View360Model;
    }

    it("is an action of the command panel, before Leave the 360 view", () => {
        const view = panelView(null);
        const items = carpetPlacesItems(view, "page");
        const ids = items.map((i) => i.id);
        expect(ids.indexOf("molten:places:even-zones")).toBeGreaterThan(-1);
        expect(ids.indexOf("molten:places:even-zones")).toBeLessThan(ids.indexOf("molten:places:leave"));
        const item = items.find((i) => i.id === "molten:places:even-zones");
        expect(item).toMatchObject({ type: "action", label: "Even out the zones" });
        expect((item as { disabled?: boolean }).disabled).toBeFalsy();
        (item as { run: () => void }).run();
        expect(view.evenZones).toHaveBeenCalledTimes(1);
    });

    it("stays enabled in the command panel when the zones are even, saying so (#2549)", () => {
        const item = carpetPlacesItems(panelView("even"), "page").find((i) => i.id === "molten:places:even-zones");
        expect((item as { disabled?: boolean }).disabled).toBeFalsy();
        expect(item).toMatchObject({ detail: "The zones already have equal widths" });
    });

    it("is left out of the command panel outside a 360 × N", () => {
        const view = panelView(null);
        (view as unknown as { shownPlacesAtom: unknown }).shownPlacesAtom = atom(null as number);
        expect(carpetPlacesItems(view, "page").some((i) => i.id === "molten:places:even-zones")).toBe(false);
    });
});

describe("On the carpet: All panels · The pages (FR-SHELL-124)", () => {
    function fakeModel(offered: boolean, group: CarpetGroup) {
        return {
            groupOffered: () => offered,
            effectiveGroup: () => (offered ? group : GroupAll),
            placeOptions: (g: CarpetGroup) => placeOptions(g === GroupPages ? 2 : 3, 2400),
            groupCarpetCount: (g: CarpetGroup) => (g === GroupPages ? 2 : 3),
            groupPlan: () => [{ blockId: "int", mode: "beside" }],
        } as unknown as View360Model;
    }

    it("offers both choices with their counts, the view's grouping selected on opening", () => {
        const choices = chooserChoices(fakeModel(true, GroupPages));
        expect(choices).toMatchObject({ offered: true, initial: GroupPages, allCount: 3, pagesCount: 2 });
        expect(choices.pages.map((o) => o.stored)).toEqual([1, 0, 0]);
        expect(choices.all.map((o) => o.stored)).toEqual([2, 1, 0]);
    });

    it("leaves the choice out when it would change nothing", () => {
        const choices = chooserChoices(fakeModel(false, GroupPages));
        expect(choices).toMatchObject({ offered: false, initial: GroupAll, pages: [], plan: [] });
    });

    it("says before the click where the other panels go", () => {
        const titles: Record<string, string> = { int: "Integration", files: "Files", rev: "Review" };
        const lines = groupPlanLines(
            [
                { blockId: "int", mode: "beside" },
                { blockId: "files", mode: "stacked" },
                { blockId: "rev", mode: "stacked" },
            ],
            (id) => titles[id],
            "Leon"
        );
        expect(lines).toEqual([
            { mode: "beside", text: "Integration will be pinned beside Leon" },
            { mode: "stacked", text: "Files, Review will be pinned under Leon, as there is no room beside it" },
        ]);
    });
});
