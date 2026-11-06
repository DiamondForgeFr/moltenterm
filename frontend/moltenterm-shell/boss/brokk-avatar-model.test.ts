// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { restingPose } from "./brokk-ask-model";
import {
    avatarSituation,
    avatarVariant,
    cardPlace,
    hangingRightPx,
    PeekGapPx,
    PeekWidthPx,
    peekPosition,
    Rect,
    ViewMarginPx,
} from "./brokk-avatar-model";

const rect = (left: number, top: number, width = 26, height = 26): Rect => ({ left, top, width, height });

describe("where the avatar stands (FR-BOSS-009, AC1, AC14)", () => {
    it("is in the sidebar's row when the sidebar is on screen, and hangs from the window's edge when it is not", () => {
        expect(avatarVariant(true)).toBe("row");
        expect(avatarVariant(false)).toBe("hanging");
    });

    it("hangs clear of the window controls the other platforms draw at the top right", () => {
        expect(hangingRightPx(false)).toBeGreaterThan(hangingRightPx(true));
    });

    it("thinks only while his own session works, never because other agents do", () => {
        expect(restingPose(avatarSituation(false))).toBe("listening");
        expect(restingPose(avatarSituation(true))).toBe("thinking");
        expect(avatarSituation(false).waiting).toBe(0);
        expect(avatarSituation(false).working).toBe(0);
    });
});

describe("where the tooltip stands", () => {
    const viewport = { width: 1200, height: 800 };

    it("is under the avatar, its right edge on the avatar's", () => {
        const place = peekPosition(rect(900, 5), viewport);
        expect(place.top).toBe(5 + 26 + PeekGapPx);
        expect(place.left + place.width).toBe(900 + 26);
        expect(place.width).toBe(PeekWidthPx);
    });

    it("stays inside the window when the avatar is near its left edge", () => {
        const place = peekPosition(rect(230, 5), viewport);
        expect(place.left).toBe(ViewMarginPx);
    });

    it("stays inside the window when the avatar is at its right edge", () => {
        const place = peekPosition(rect(1190, 5), viewport);
        expect(place.left + place.width).toBeLessThanOrEqual(viewport.width - ViewMarginPx);
    });

    it("shrinks in a window narrower than itself", () => {
        const place = peekPosition(rect(100, 5), { width: 200, height: 600 });
        expect(place.width).toBe(200 - 2 * ViewMarginPx);
        expect(place.left).toBe(ViewMarginPx);
    });
});

describe("where his panel stands", () => {
    it("is beside a docked sidebar, from under the avatar, where the content begins", () => {
        const place = cardPlace(rect(230, 5), rect(8, 0, 264, 800), rect(272, 0, 928, 800));
        expect(place.top).toBe(`${5 + 26 + PeekGapPx}px`);
        expect(place.left).toBe(`${PeekGapPx}px`);
        expect(place.right).toBeUndefined();
    });

    it("is beside a sidebar that floats over the content, past its right edge", () => {
        const place = cardPlace(rect(230, 12), rect(8, 8, 264, 780), rect(0, 0, 1200, 800));
        expect(place.left).toBe(`${8 + 264 + PeekGapPx}px`);
    });

    it("is under the avatar, aligned with its right edge, when it hangs from the window's edge", () => {
        const place = cardPlace(rect(1150, 0, 14, 14), null, rect(0, 0, 1200, 800));
        expect(place.right).toBe(`${1200 - 1164}px`);
        expect(place.left).toBeUndefined();
        expect(place.top).toBe(`${14 + PeekGapPx}px`);
    });

    it("never grows past the window", () => {
        expect(cardPlace(rect(230, 5), rect(8, 0, 264, 800), rect(272, 0, 928, 800)).maxHeight).toBe(
            `calc(100% - ${5 + 26 + PeekGapPx}px - ${ViewMarginPx}px)`
        );
    });
});
