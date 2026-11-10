// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { RpcApi } from "@/app/store/wshclientapi";
import { describe, expect, it, vi } from "vitest";
import { placeOptions } from "./carpet-places";
import { OfferGrid } from "./view360-meta";
import {
    adoptedPlaces,
    crossedThreshold,
    everyViewSettings,
    offerDue,
    offerEligible,
    offerKeptGrid,
    readStoredPlaces,
    storeEveryView,
    View360PlacesSettingKey,
} from "./view360-offer";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetConfigCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

describe("who is offered the switch (FR-SHELL-066-AC11, #2180)", () => {
    it("asks a view that never was in 360 view while the developer never chose", () => {
        expect(offerEligible(undefined, false)).toBe(true);
        expect(offerEligible("", false)).toBe(true);
        // A view with a history (a 360 view of its own, a 360 × N, an answer) is not asked.
        expect(offerEligible(undefined, true)).toBe(false);
        // Nor once the setting is chosen, whatever it is.
        for (const chosen of ["auto", "grid", "always"]) {
            expect(offerEligible(chosen, false)).toBe(false);
        }
    });

    it("keeps the grid of a view that said so, only while the developer never chose", () => {
        expect(offerKeptGrid(undefined, OfferGrid)).toBe(true);
        expect(offerKeptGrid(undefined, null)).toBe(false);
        // A setting chosen since wins over the view's own answer.
        expect(offerKeptGrid("auto", OfferGrid)).toBe(false);
        expect(offerKeptGrid("always", OfferGrid)).toBe(false);
    });
});

describe("when the offer shows (AC11)", () => {
    // Four carpet columns on a wide view: 1, 2 and 3 are all offered.
    const wide = placeOptions(4, 2400, 0, 0);
    const due = { eligible: true, columnCount: 5, columnsOver: true, active: false, options: wide };

    it("shows beyond the threshold with the numbers the chooser offers", () => {
        expect(offerDue(due)).toBe(true);
        expect(wide.filter((o) => o.offered).map((o) => o.n)).toEqual([1, 2, 3]);
    });

    it("waits for the third column, and for the threshold", () => {
        expect(offerDue({ ...due, columnCount: 2 })).toBe(false);
        expect(offerDue({ ...due, columnsOver: false })).toBe(false);
    });

    it("does not show for a view that is not eligible, or that is already in 360 view", () => {
        expect(offerDue({ ...due, eligible: false })).toBe(false);
        expect(offerDue({ ...due, active: true })).toBe(false);
    });

    it("needs at least one number that applies", () => {
        // Two carpet columns store something with 1 only: 2 and 3 are greyed, 1 is offered.
        const two = placeOptions(2, 2400, 0, 0);
        expect(two.filter((o) => o.offered).map((o) => o.n)).toEqual([1]);
        expect(offerDue({ ...due, columnCount: 3, options: two })).toBe(true);
        // Too narrow for any number: nothing to offer.
        const narrow = placeOptions(4, 700, 0, 0);
        expect(narrow.some((o) => o.offered)).toBe(false);
        expect(offerDue({ ...due, options: narrow })).toBe(false);
        expect(offerDue({ ...due, options: [] })).toBe(false);
    });
});

describe("Do the same in every view (AC11)", () => {
    it("stores Automatic with the number of visible panels, or Keep the grid", () => {
        expect(everyViewSettings(2)).toEqual({ "moltenterm:view360": "auto", [View360PlacesSettingKey]: "2" });
        expect(everyViewSettings(OfferGrid)).toEqual({ "moltenterm:view360": "grid" });
    });

    it("writes them to the settings in one call", async () => {
        await storeEveryView(3);
        expect(RpcApi.SetConfigCommand).toHaveBeenLastCalledWith(
            {},
            { "moltenterm:view360": "auto", "moltenterm:view360places": "3" }
        );
        await storeEveryView(OfferGrid);
        expect(RpcApi.SetConfigCommand).toHaveBeenLastCalledWith({}, { "moltenterm:view360": "grid" });
    });

    it("reads the stored number as the settings choices write it, a string from 1 to 3", () => {
        expect(readStoredPlaces("2")).toBe(2);
        expect(readStoredPlaces(3)).toBe(3);
        for (const bad of [undefined, null, "", " ", "0", "4", "two", 2.5, "1.5"]) {
            expect(readStoredPlaces(bad)).toBeNull();
        }
    });

    it("gives the number to another view only under Automatic", () => {
        expect(adoptedPlaces("auto", "2")).toBe(2);
        expect(adoptedPlaces("auto", undefined)).toBeNull();
        expect(adoptedPlaces("grid", "2")).toBeNull();
        expect(adoptedPlaces("always", "2")).toBeNull();
        expect(adoptedPlaces(undefined, "2")).toBeNull();
    });

    it("applies it when a column is added across the screen's threshold, never at a first pass or beyond it", () => {
        expect(crossedThreshold(2, 3, 2)).toBe(true);
        expect(crossedThreshold(3, 4, 3)).toBe(true);
        expect(crossedThreshold(3, 4, 2)).toBe(false);
        expect(crossedThreshold(4, 3, 2)).toBe(false);
        expect(crossedThreshold(null, 5, 2)).toBe(false);
        // Under three columns nothing is stored.
        expect(crossedThreshold(1, 2, 1)).toBe(false);
    });
});
