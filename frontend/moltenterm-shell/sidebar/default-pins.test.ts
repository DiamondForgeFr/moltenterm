// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A fresh install's top row (FR-SHELL-080, TC-SHELL-226, #1296).

import { describe, expect, it } from "vitest";
import { defaultGlobalPins, SeedGlobalPinsMetaKey, seedPinsMeta } from "./default-pins";
import { configPaneIcons } from "./view-menu-model";
import { GlobalPinsMetaKey, readGlobalPins } from "./view-pins-model";

const t = (key: string) => `<${key}>`;
let n = 0;
const random = () => (n++ % 97) / 97;

describe("the default top row (#1296)", () => {
    it("is Terminal, Web page, Pilotage and Project, one panel each, named in the interface language", () => {
        const pins = defaultGlobalPins(t, 1_000, random);
        expect(pins.map((p) => p.config.panes[0].view)).toEqual([
            "term",
            "molten-browser",
            "molten-reviews",
            "molten-project",
        ]);
        expect(pins.map((p) => p.name)).toEqual([
            "<palette.panelNames.terminal>",
            "<palette.panelNames.browser>",
            "<palette.panelNames.reviews>",
            "<palette.panels.missionControl>",
        ]);
        expect(new Set(pins.map((p) => p.id)).size).toBe(4);
        expect(readGlobalPins({ [GlobalPinsMetaKey]: pins })).toHaveLength(4);
        expect(pins.map((p) => configPaneIcons(p.config)).every((icons) => icons.length === 1)).toBe(true);
    });

    it("is written only with wavesrv's first-launch mark, which it clears", () => {
        const seeded = seedPinsMeta({ [SeedGlobalPinsMetaKey]: true }, t, 1_000, random);
        expect(readGlobalPins(seeded)).toHaveLength(4);
        expect(seeded[SeedGlobalPinsMetaKey]).toBeNull();
    });

    it("never changes an existing row, even an empty one", () => {
        expect(seedPinsMeta({}, t, 1_000, random)).toBeNull();
        expect(seedPinsMeta({ [GlobalPinsMetaKey]: [] }, t, 1_000, random)).toBeNull();
        const kept = seedPinsMeta(
            {
                [SeedGlobalPinsMetaKey]: true,
                [GlobalPinsMetaKey]: [
                    { id: "g1", name: "Mine", rev: 1, config: { tree: { pane: 0 }, panes: [{ view: "term" }] } },
                ],
            },
            t,
            1_000,
            random
        );
        expect(kept).toEqual({ [SeedGlobalPinsMetaKey]: null });
    });
});
