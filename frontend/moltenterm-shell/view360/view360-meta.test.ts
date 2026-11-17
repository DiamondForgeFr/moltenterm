// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { RpcApi } from "@/app/store/wshclientapi";
import { describe, expect, it, vi } from "vitest";
import {
    hasView360History,
    OfferGrid,
    setTabOfferAnswer,
    storedOfferAnswer,
    View360FixedPxMetaKey,
    View360FractionsMetaKey,
    View360MetaKey,
    View360OfferMetaKey,
    View360PinsMetaKey,
    View360PlacesMetaKey,
} from "./view360-meta";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

function tab(meta: Record<string, unknown>): Tab {
    return { oid: "tab-1", meta } as unknown as Tab;
}

describe("a view's 360 history (FR-SHELL-066-AC11, #2180)", () => {
    it("has none while nothing of the 360 view was ever stored on it", () => {
        expect(hasView360History(tab({}))).toBe(false);
        expect(hasView360History(null)).toBe(false);
        // The proportions are the developer's splitters in the normal layout, not a 360 view.
        expect(hasView360History(tab({ [View360FractionsMetaKey]: [0.5, 0.5] }))).toBe(false);
        expect(hasView360History(tab({ "tab:name": "main" }))).toBe(false);
    });

    it("has one once the view had a manual choice, a 360 × N, pins, a fixed zone or an answer", () => {
        expect(hasView360History(tab({ [View360MetaKey]: true }))).toBe(true);
        // Turned off by hand says the view was in 360 view.
        expect(hasView360History(tab({ [View360MetaKey]: false }))).toBe(true);
        expect(hasView360History(tab({ [View360PlacesMetaKey]: 2 }))).toBe(true);
        expect(hasView360History(tab({ [View360PinsMetaKey]: { b1: { mode: "beside" } } }))).toBe(true);
        // Written on entering the view and kept after leaving it: the mark of a view made before the offer existed.
        expect(hasView360History(tab({ [View360FixedPxMetaKey]: 640 }))).toBe(true);
        expect(hasView360History(tab({ [View360OfferMetaKey]: OfferGrid }))).toBe(true);
    });

    it("ignores marks that are not well formed", () => {
        expect(hasView360History(tab({ [View360PlacesMetaKey]: 9 }))).toBe(false);
        expect(hasView360History(tab({ [View360PinsMetaKey]: {} }))).toBe(false);
        expect(hasView360History(tab({ [View360FixedPxMetaKey]: -1 }))).toBe(false);
        expect(hasView360History(tab({ [View360OfferMetaKey]: "elsewhere" }))).toBe(false);
    });

    it("keeps the view's answer to the offer in its meta", async () => {
        expect(storedOfferAnswer(tab({ [View360OfferMetaKey]: OfferGrid }))).toBe(OfferGrid);
        expect(storedOfferAnswer(tab({}))).toBeNull();
        await setTabOfferAnswer("tab-1", OfferGrid);
        expect(vi.mocked(RpcApi.SetMetaCommand)).toHaveBeenLastCalledWith(
            {},
            { oref: "tab:tab-1", meta: { [View360OfferMetaKey]: OfferGrid } }
        );
    });
});
