// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeCaptureOffers, OfferGapMs, shownByPanel } from "./materials-panel-capture";

describe("materials panel capture (#1560)", () => {
    it("reads what a panel shows", () => {
        expect(shownByPanel({ view: "preview", file: "/a/plan.md" })).toEqual({ file: "/a/plan.md" });
        expect(shownByPanel({ view: "term" })).toBeNull();
        expect(shownByPanel({ view: "preview" })).toBeNull();
        expect(shownByPanel(null)).toBeNull();
    });

    it("offers a panel's capture once per gap, again when it shows something else", () => {
        let t = 1000;
        const sent: string[] = [];
        const offer = makeCaptureOffers(
            (blockId, shown) => sent.push(blockId + ":" + (shown.file ?? shown.urls?.[0])),
            () => t
        );
        offer("b1", { file: "/a" }, "img");
        offer("b1", { file: "/a" }, "img");
        offer("b1", null, "img");
        offer("b1", { file: "/a" }, "");
        expect(sent).toEqual(["b1:/a"]);
        offer("b1", { file: "/b" }, "img");
        t += OfferGapMs;
        offer("b1", { file: "/b" }, "img");
        expect(sent).toEqual(["b1:/a", "b1:/b", "b1:/b"]);
    });
});
