// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    columnsForPlaces,
    defaultColumnThreshold,
    LaptopColumns,
    parseScreenKey,
    readScreensAsked,
    readScreenThresholds,
    type ScreenInfo,
    screenRows,
    screenSaveOffered,
    thresholdFor,
    WideColumns,
    withAsked,
    withoutScreen,
    withThreshold,
} from "./screen-threshold";

const laptop: ScreenInfo = { key: "1512x982@2", widthpx: 1512, heightpx: 982, scalefactor: 2 };
const wide: ScreenInfo = { key: "3440x1440@1", widthpx: 3440, heightpx: 1440, scalefactor: 1 };

describe("column threshold per screen (FR-SHELL-066, #1083)", () => {
    it("defaults by the screen's width: a laptop 2 columns, a large or wide screen 3", () => {
        expect(defaultColumnThreshold(1280)).toBe(LaptopColumns);
        expect(defaultColumnThreshold(1512)).toBe(2);
        expect(defaultColumnThreshold(1920)).toBe(2);
        expect(defaultColumnThreshold(2560)).toBe(WideColumns);
        expect(defaultColumnThreshold(3440)).toBe(3);
        expect(thresholdFor({}, laptop)).toBe(2);
        expect(thresholdFor({}, wide)).toBe(3);
        // No screen known (a preview, an older main process): the laptop's.
        expect(thresholdFor({}, null)).toBe(2);
    });

    it("remembers a threshold for each screen apart", () => {
        let stored = withThreshold({}, laptop, 3);
        stored = withThreshold(stored, wide, 4);
        expect(thresholdFor(stored, laptop)).toBe(3);
        expect(thresholdFor(stored, wide)).toBe(4);
        // Same size, another scale factor: another screen.
        expect(thresholdFor(stored, { ...laptop, key: "1512x982@1", scalefactor: 1 })).toBe(2);
        // Survives a round trip through the meta (a restart).
        const reread = readScreenThresholds(JSON.parse(JSON.stringify(stored)));
        expect(reread).toEqual(stored);
        expect(thresholdFor(reread, wide)).toBe(4);
        // Forgotten: the default again.
        expect(thresholdFor(withoutScreen(stored, wide.key), wide)).toBe(3);
        expect(withoutScreen(stored, "missing")).toBe(stored);
        // An invalid value is refused.
        expect(withThreshold(stored, laptop, 0)).toBe(stored);
        expect(withThreshold(stored, null, 3)).toBe(stored);
    });

    it("keeps only well-formed entries from the meta", () => {
        expect(readScreenThresholds(null)).toEqual({});
        expect(readScreenThresholds([1, 2])).toEqual({});
        expect(
            readScreenThresholds({
                good: { columns: 3 },
                float: { columns: 2.5 },
                big: { columns: 40 },
                text: { columns: "3" },
                none: null,
                sized: { columns: 2, widthpx: 1512, heightpx: -1, scalefactor: 2 },
            })
        ).toEqual({ good: { columns: 3 }, sized: { columns: 2, widthpx: 1512, scalefactor: 2 } });
        expect(parseScreenKey("1512x982@2")).toEqual({ widthpx: 1512, heightpx: 982, scalefactor: 2 });
        expect(parseScreenKey("bogus")).toBeNull();
    });

    it("lists the current screen first, with its default when nothing was chosen, then the widest", () => {
        const stored = withThreshold(withThreshold({}, wide, 4), { ...laptop, key: "1280x800@2", widthpx: 1280 }, 2);
        const rows = screenRows(stored, laptop);
        expect(rows.map((r) => [r.key, r.columns, r.current, r.isDefault])).toEqual([
            ["1512x982@2", 2, true, true],
            ["3440x1440@1", 4, false, false],
            ["1280x800@2", 2, false, false],
        ]);
        expect(screenRows(stored, wide)[0]).toMatchObject({ key: wide.key, current: true, isDefault: false });
        // An entry stored without its size reads it from its key.
        expect(screenRows({ "2560x1440@1": { columns: 3 } }, null)[0]).toMatchObject({ widthpx: 2560, heightpx: 1440 });
        expect(screenRows({}, null)).toEqual([]);
    });
});

describe("offering to save a screen (FR-SHELL-066-AC12, #2180)", () => {
    it("asks for a screen the list does not hold, once", () => {
        expect(screenSaveOffered({}, {}, laptop)).toBe(true);
        // Held by the list (a threshold was chosen): never asked.
        expect(screenSaveOffered(withThreshold({}, laptop, 2), {}, laptop)).toBe(false);
        // Declined: not asked again for that screen, still asked for another.
        const declined = withAsked({}, laptop);
        expect(screenSaveOffered({}, declined, laptop)).toBe(false);
        expect(screenSaveOffered({}, declined, wide)).toBe(true);
        // No screen known (a preview, an older main process): nothing to save.
        expect(screenSaveOffered({}, {}, null)).toBe(false);
    });

    it("remembers the declined screens across a restart, ignoring anything malformed", () => {
        const asked = withAsked(withAsked({}, laptop), wide);
        expect(readScreensAsked(JSON.parse(JSON.stringify(asked)))).toEqual({
            [laptop.key]: true,
            [wide.key]: true,
        });
        expect(readScreensAsked(null)).toEqual({});
        expect(readScreensAsked([laptop.key])).toEqual({});
        expect(readScreensAsked({ good: true, no: false, text: "yes", "": true })).toEqual({ good: true });
        expect(withAsked({ a: true }, null)).toEqual({ a: true });
    });

    it("saves the threshold of a picked number: the first column and the visible panels beside it", () => {
        expect(columnsForPlaces(1, 3)).toBe(2);
        expect(columnsForPlaces(2, 2)).toBe(3);
        expect(columnsForPlaces(3, 2)).toBe(4);
        // Without a number, or one the list would not hold, the threshold in effect.
        expect(columnsForPlaces(null, 3)).toBe(3);
        expect(columnsForPlaces(40, 3)).toBe(3);
        expect(columnsForPlaces(1.5, 3)).toBe(3);
    });
});
