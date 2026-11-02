// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A fresh install's top row (FR-SHELL-080, TC-SHELL-226, #1296).

import { describe, expect, it } from "vitest";
import { defaultGlobalPins, localizedPin, SeedGlobalPinsMetaKey, seedPinsMeta, typedNamePin } from "./default-pins";
import { configPaneIcons } from "./view-menu-model";
import { GlobalPin, GlobalPinsMetaKey, readGlobalPins } from "./view-pins-model";

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

describe("a seeded pin's name (#1307)", () => {
    const fr: Record<string, string> = {
        "palette.panelNames.terminal": "Terminal",
        "palette.panelNames.browser": "Page web",
        "palette.panelNames.reviews": "Intégration",
        "palette.panels.missionControl": "Projet",
    };
    const tr = (key: string) => fr[key] ?? key;
    const reviews = (name: string, extra: Partial<GlobalPin> = {}): GlobalPin => ({
        id: "g1",
        name,
        rev: 1,
        config: { tree: { pane: 0 }, panes: [{ view: "molten-reviews" }] },
        ...extra,
    });

    it("keeps its key, so it shows in the interface language and follows renames of the text", () => {
        const pins = defaultGlobalPins(t, 1_000, random);
        expect(pins.map((p) => p.namekey)).toEqual([
            "palette.panelNames.terminal",
            "palette.panelNames.browser",
            "palette.panelNames.reviews",
            "palette.panels.missionControl",
        ]);
        expect(localizedPin(pins[2], tr).name).toBe("Intégration");
    });

    it("is recognised on pins seeded before the key was kept, and the key is kept from then on", () => {
        for (const old of ["Pilotage", "Control room"]) {
            const shown = localizedPin(reviews(old), tr);
            expect(shown.name).toBe("Intégration");
            expect(shown.namekey).toBe("palette.panelNames.reviews");
        }
    });

    it("is recognised after Update the pinned view added panels to it", () => {
        const updated = reviews("Pilotage", {
            rev: 2,
            config: {
                tree: { dir: "row", children: [{ pane: 0 }, { pane: 1 }] },
                panes: [{ view: "molten-reviews" }, { view: "term" }],
            },
        });
        expect(localizedPin(updated, tr).name).toBe("Intégration");
    });

    it("leaves a name the developer typed as typed", () => {
        expect(localizedPin(reviews("Revue PR"), tr)).toEqual(reviews("Revue PR"));
        // A default name on a view without that default's panel was typed.
        expect(localizedPin(reviews("Projet"), tr).name).toBe("Projet");
        expect(localizedPin(reviews("Projet"), tr).namekey).toBeUndefined();
    });

    it("stops following the language once renamed", () => {
        const seeded = localizedPin(reviews("Pilotage"), tr);
        const renamed = typedNamePin(seeded, "Revue PR");
        expect(renamed.namekey).toBeUndefined();
        expect(localizedPin(renamed, tr).name).toBe("Revue PR");
    });

    it("falls back to the stored name when the key has no text", () => {
        expect(localizedPin(reviews("Pilotage", { namekey: "gone.key" }), tr).name).toBe("Pilotage");
    });
});
