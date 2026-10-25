// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The PR panel is named Control room / Pilotage (#1124, FR-REV-001); its keys, view type and stored layouts keep the
// "reviews" ids. The review action and the Review tab keep the word review.

import { describe, expect, it } from "vitest";
import { flattenKeys, resolveKey, shippedDictionary, translate } from "../i18n/i18n-core";
import { panelIcon, panelTitle } from "../tab-identity";

const OldPanelName = /\b(Reviews|Revues)\b|\b(Reviews|review) list\b|liste des revues|panneaux? de revues/;

const PanelNameKeys = [
    "reviews.viewName",
    "tabs.views.reviews",
    "palette.panelNames.reviews",
    "cmdpanel.kinds.reviews.name",
    "mc.remote.toReviews",
    "sessions.from.reviews",
];

describe("the PR panel's name (#1124)", () => {
    it("is Control room in English and Pilotage in French", () => {
        for (const key of PanelNameKeys) {
            expect(translate("en", key)).toBe("Control room");
            expect(translate("fr", key)).toBe("Pilotage");
        }
        expect(translate("en", "mc.setup.prepared.openReviews", { number: 7 })).toBe("Open #7 in Control room");
        expect(translate("fr", "mc.setup.prepared.openReviews", { number: 7 })).toBe("Ouvrir #7 dans Pilotage");
        expect(translate("en", "browser.testContext.openInReviews")).toBe("Open in Control room");
        expect(translate("fr", "browser.testContext.openInReviews")).toBe("Ouvrir dans Pilotage");
    });

    for (const code of ["en", "fr"]) {
        it(`${code}.json no longer names the panel Reviews or Revues`, () => {
            const dict = shippedDictionary(code);
            const left = flattenKeys(dict)
                .map((k) => `${k}: ${resolveKey(dict, k)}`)
                .filter((line) => OldPanelName.test(line.slice(line.indexOf(": ") + 2)));
            expect(left).toEqual([]);
        });
    }

    it("opens a saved layout's molten-reviews panel under its new name", () => {
        expect(panelTitle({ view: "molten-reviews" })).toBe("Control room");
        expect(panelIcon({ view: "molten-reviews" })).toBe("code-pull-request");
    });
});
