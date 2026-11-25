// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "Even out the zones" in the view's menu (FR-SHELL-123-AC12, AC20, #2433): the sidebar's view menu and the 360 toggle's
// menu are the same list.

import { atom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import type { View360Model } from "./view360-model";
import { view360MenuItems } from "./view360-toggle";

vi.mock("@/app/store/contextmenu", () => ({ ContextMenuModel: { getInstance: () => ({ showContextMenu: vi.fn() }) } }));
vi.mock("@/app/store/global", async () => {
    const { globalStore } = await import("@/app/store/jotaiStore");
    return { atoms: {}, globalStore, WOS: {}, getApi: () => ({}) };
});
vi.mock("@/layout/lib/layoutModelHooks", () => ({ getLayoutModelForStaticTab: () => null }));
vi.mock("../settings/settings-open", () => ({ openSettingsSection: vi.fn() }));
vi.mock("./screen-store", () => ({ ScreenModel: { getInstance: () => ({ setThreshold: vi.fn() }) } }));

function menuView(shown: number, why: "single" | "even" | null) {
    return {
        decisionAtom: atom({ active: true }),
        columnCountAtom: atom(5),
        thresholdAtom: atom(3),
        shownPlacesAtom: atom(shown),
        placesBlockId: () => "b-c1",
        placeOptions: () => [],
        evenZonesWhy: () => why,
        evenZones: vi.fn(() => true),
        setActive: vi.fn(),
    } as unknown as View360Model;
}

describe("Even out the zones in the view's menu", () => {
    it("is listed under a 360 × N and runs the action", () => {
        const view = menuView(2, null);
        const item = view360MenuItems(view).find((i) => i.label === "Even out the zones");
        expect(item).toMatchObject({ enabled: true });
        item.click();
        expect(view.evenZones).toHaveBeenCalledTimes(1);
    });

    it("stays enabled, with its reason shown, when the zones are already even (#2549)", () => {
        const item = view360MenuItems(menuView(2, "even")).find((i) => i.label === "Even out the zones");
        expect(item.enabled).toBe(true);
        expect(item.sublabel).toBe("The zones already have equal widths");
        expect(item.tooltip).toBe("The zones already have equal widths");
    });

    it("says it has nothing to do when a single zone is in view, still enabled (#2549)", () => {
        const item = view360MenuItems(menuView(1, "single")).find((i) => i.label === "Even out the zones");
        expect(item.enabled).toBe(true);
        expect(item.sublabel).toBe("One zone is in view: there is nothing to even out");
    });

    it("lists every 360 × N the screen allows, also those that store nothing (#2549)", () => {
        const view = menuView(null as number, null);
        (view as unknown as { placeOptions: () => unknown }).placeOptions = () => [
            { n: 1, offered: true, stored: 1, slotPx: 900 },
            { n: 2, offered: true, stored: 0, slotPx: 600 },
            { n: 3, offered: false, reason: "narrow", stored: 0, slotPx: 300 },
        ];
        const labels = view360MenuItems(view).map((i) => i.label);
        expect(labels).toContain("Store on the carpet: 2 visible panels on the right");
        expect(labels).not.toContain("Store on the carpet: 3 visible panels on the right");
    });

    it("shows no reason while it can run", () => {
        const item = view360MenuItems(menuView(2, null)).find((i) => i.label === "Even out the zones");
        expect(item.sublabel).toBeUndefined();
    });

    it("is left out when the view has no 360 × N", () => {
        const items = view360MenuItems(menuView(null as number, "single"));
        expect(items.some((i) => i.label === "Even out the zones")).toBe(false);
    });
});
