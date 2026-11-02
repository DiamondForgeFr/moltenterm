// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { placeOptions } from "./carpet-places";
import type { PanelPlacement } from "./view360-model";
import { CarpetGroup, GroupAll, GroupPages } from "./carpet-group";
import type { View360Model } from "./view360-model";
import {
    CarpetHeaderButton,
    chooserChoices,
    groupPlanLines,
    headerPlacement,
    optionCaption,
    optionsWhy,
} from "./view360-places";

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
        expect(browser.indexOf("<CarpetHeaderButton")).toBeLessThan(browser.indexOf('data-role="command-panel-trigger"'));
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
        const few = placeOptions(2, 3160);
        expect(few.map(optionCaption).slice(1)).toEqual(["Nothing to store", "Nothing to store"]);
        expect(optionsWhy(few)).toContain("nothing would be stored");
        expect(optionsWhy(placeOptions(6, 3160))).toBeNull();
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
