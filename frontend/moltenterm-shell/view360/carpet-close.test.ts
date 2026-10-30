// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { closeAnchorColumn, closeReplacement } from "./carpet-close";

// Eight carpet panels, two places in view.
const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];

describe("the neighbour tab takes the freed place (FR-SHELL-126-AC3)", () => {
    it("brings the next stored panel to the right in when a visible one closes", () => {
        // c3 and c4 in view: closing c3 leaves c4, and c5 comes in.
        expect(closeReplacement(ids, ["c3", "c4"])).toBe("c5");
        expect(closeAnchorColumn(ids, ["c3", "c4"], "c3")).toBe("c4");
        expect(closeAnchorColumn(ids, ["c3", "c4"], "c4")).toBe("c3");
    });

    it("at the start of the carpet", () => {
        expect(closeAnchorColumn(ids, ["c1", "c2"], "c1")).toBe("c2");
        expect(closeAnchorColumn(ids, ["c1", "c2"], "c2")).toBe("c1");
    });

    it("in the middle of the carpet", () => {
        expect(closeAnchorColumn(ids, ["c4", "c5"], "c4")).toBe("c5");
        expect(closeAnchorColumn(ids, ["c4", "c5"], "c5")).toBe("c4");
    });

    it("at the end of the carpet, takes the stored panel to the left when none is to the right", () => {
        expect(closeReplacement(ids, ["c7", "c8"])).toBe("c6");
        expect(closeAnchorColumn(ids, ["c7", "c8"], "c8")).toBe("c6");
        expect(closeAnchorColumn(ids, ["c7", "c8"], "c7")).toBe("c6");
    });

    it("keeps the places in view when a stored panel closes", () => {
        expect(closeAnchorColumn(ids, ["c4", "c5"], "c1")).toBe("c4");
        expect(closeAnchorColumn(ids, ["c4", "c5"], "c8")).toBe("c4");
    });

    it("leaves what is in view alone when nothing is stored", () => {
        const three = ["c1", "c2", "c3"];
        expect(closeReplacement(three, three)).toBeNull();
        expect(closeAnchorColumn(three, three, "c1")).toBe("c2");
        expect(closeAnchorColumn(three, three, "c3")).toBe("c1");
    });

    it("has no anchor when the last panel closes or the column is unknown", () => {
        expect(closeAnchorColumn(["c1"], ["c1"], "c1")).toBeNull();
        expect(closeAnchorColumn(ids, ["c1"], "zzz")).toBeNull();
        expect(closeAnchorColumn(null, null, "c1")).toBeNull();
    });

    it("works with one place", () => {
        expect(closeAnchorColumn(ids, ["c4"], "c4")).toBe("c5");
        expect(closeAnchorColumn(ids, ["c8"], "c8")).toBe("c7");
    });
});
