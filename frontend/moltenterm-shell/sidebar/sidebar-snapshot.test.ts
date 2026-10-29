// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseSnapshot, snapshotFits, snapshotKey, staleSnapshotKeys } from "./sidebar-snapshot";

describe("the neighbour's captured sidebar (#1261, TC-SHELL-218)", () => {
    it("reads back only a well-formed image capture", () => {
        const raw = JSON.stringify({ url: "data:image/png;base64,AAA", width: 256, height: 1041, at: 5 });
        expect(parseSnapshot(raw)).toEqual({ url: "data:image/png;base64,AAA", width: 256, height: 1041, at: 5 });
        expect(parseSnapshot(JSON.stringify({ url: "https://example.com/x.png", width: 1, height: 1 }))).toBeNull();
        expect(parseSnapshot(JSON.stringify({ url: "data:image/png;base64,AAA", width: 0, height: 1 }))).toBeNull();
        expect(parseSnapshot("not json")).toBeNull();
        expect(parseSnapshot(null)).toBeNull();
    });

    it("is shown only when the sidebar kept its size, so the swipe lands on the same pixels", () => {
        const snap = { url: "data:image/png;base64,AAA", width: 256, height: 1041, at: 0 };
        expect(snapshotFits(snap, 256, 1041)).toBe(true);
        expect(snapshotFits(snap, 256.5, 1040.4)).toBe(true);
        expect(snapshotFits(snap, 300, 1041)).toBe(false);
        expect(snapshotFits(null, 256, 1041)).toBe(false);
    });

    it("drops the captures of workspaces that no longer exist, and nothing else", () => {
        const keys = [snapshotKey("a"), snapshotKey("b"), "moltenterm:sidebar-switch", "other"];
        expect(staleSnapshotKeys(keys, ["a"])).toEqual([snapshotKey("b")]);
    });
});
