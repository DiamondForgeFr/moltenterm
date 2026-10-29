// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The PR panel is named Integration / Intégration (#1303, FR-REV-001; Control room / Pilotage before, #1124); its keys,
// view type and stored layouts keep the "reviews" ids. The review action and the Review tab keep the word review. The
// agent hook setting, which "Integration" named before, is Agent hookup / Connexion de l'agent (FR-SHELL-040).

import { describe, expect, it } from "vitest";
import { flattenKeys, resolveKey, shippedDictionary, translate } from "../i18n/i18n-core";
import { panelIcon, panelTitle } from "../tab-identity";

const OldPanelName = /\b(Reviews|Revues)\b|\b(Reviews|review) list\b|liste des revues|panneaux? de revues/;

// "Pilotage par un agent" is the browser tab an agent drives, not the panel.
const FormerPanelName = /Control room|\bPilotage\b(?! par un agent)/i;

const PanelNameKeys = [
    "reviews.viewName",
    "tabs.views.reviews",
    "palette.panelNames.reviews",
    "cmdpanel.kinds.reviews.name",
    "mc.remote.toReviews",
    "sessions.from.reviews",
];

describe("the PR panel's name (#1303)", () => {
    it("is Integration in English and Intégration in French", () => {
        for (const key of PanelNameKeys) {
            expect(translate("en", key)).toBe("Integration");
            expect(translate("fr", key)).toBe("Intégration");
        }
        expect(translate("en", "mc.setup.prepared.openReviews", { number: 7 })).toBe("Open #7 in Integration");
        expect(translate("fr", "mc.setup.prepared.openReviews", { number: 7 })).toBe(
            "Ouvrir #7 dans le panneau Intégration"
        );
        expect(translate("en", "browser.testContext.openInReviews")).toBe("Open in Integration");
        expect(translate("fr", "browser.testContext.openInReviews")).toBe("Ouvrir dans le panneau Intégration");
    });

    for (const code of ["en", "fr"]) {
        it(`${code}.json no longer names the panel Reviews or Revues`, () => {
            const dict = shippedDictionary(code);
            const left = flattenKeys(dict)
                .map((k) => `${k}: ${resolveKey(dict, k)}`)
                .filter((line) => OldPanelName.test(line.slice(line.indexOf(": ") + 2)));
            expect(left).toEqual([]);
        });

        it(`${code}.json no longer names the panel Control room or Pilotage`, () => {
            const dict = shippedDictionary(code);
            const left = flattenKeys(dict)
                .map((k) => `${k}: ${resolveKey(dict, k)}`)
                .filter((line) => FormerPanelName.test(line.slice(line.indexOf(": ") + 2)));
            expect(left).toEqual([]);
        });
    }

    it("names the agent hook setting Agent hookup, so Integration means the panel only", () => {
        expect(translate("en", "settings.groups.integration")).toBe("Agent hookup");
        expect(translate("fr", "settings.groups.integration")).toBe("Connexion de l'agent");
        expect(translate("en", "settings.items.agent:integrate.label")).toBe("Agent hookup");
        expect(translate("fr", "settings.items.agent:integrate.label")).toBe("Connexion de l'agent");
    });

    it("opens a saved layout's molten-reviews panel under its new name", () => {
        expect(panelTitle({ view: "molten-reviews" })).toBe("Integration");
        expect(panelIcon({ view: "molten-reviews" })).toBe("code-pull-request");
    });
});
