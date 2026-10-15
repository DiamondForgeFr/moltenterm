// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { panelTitle } from "../tab-identity";
import { registerMoltentermViews } from "../views";
import { buildRadarTicks, RadarBlockFacts, RadarColumnInput, RadarText, radarWindowLine } from "./radar-model";

// Wave's views, read from its block registry so a view it adds later is checked too.
function waveViewTypes(): string[] {
    const source = readFileSync(new URL("../../app/block/blockregistry.ts", import.meta.url), "utf8");
    return [...source.matchAll(/BlockRegistry\.set\("([^"]+)"/g)].map((m) => m[1]);
}

function registeredViewTypes(): string[] {
    const molten = new Map<string, unknown>();
    registerMoltentermViews(molten as Parameters<typeof registerMoltentermViews>[0]);
    return [...new Set([...waveViewTypes(), ...molten.keys()])];
}

// The title the radar shows for a panel of this view with nothing else to name it, as radar-store.ts computes it.
function radarTitleOf(view: string): string {
    const facts: Record<string, RadarBlockFacts> = {
        b: { view, agent: false, title: panelTitle({ view }), attention: null },
    };
    const columns: RadarColumnInput[] = [{ columnId: "c", leaves: [{ nodeId: "n", blockId: "b" }] }];
    return buildRadarTicks(columns, facts, ["c"])[0].title;
}

describe("radar titles (#642)", () => {
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("knows the views of both registries", () => {
        const views = registeredViewTypes();
        expect(views).toContain("term");
        expect(views).toContain("tips");
        expect(views).toContain("molten-review-ai");
    });

    for (const locale of ["en", "fr"]) {
        it(`never shows a raw view type as a title (${locale})`, () => {
            I18nModel.getInstance().setLanguageSetting(locale);
            for (const view of registeredViewTypes()) {
                const title = radarTitleOf(view);
                expect(title, view).not.toBe("");
                expect(title, view).not.toBe(view);
                expect(title, view).not.toMatch(/^molten-/i);
                // Not the generic name either: every registered view has its own dictionary title ("Tips", "Web"
                // happen to match their view type's word, which is why the check is not case-insensitive).
                expect(title, view).not.toBe(RadarText.untitled);
            }
        });
    }

    it("names the Review AI and Tips panes in the interface language", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        expect(radarTitleOf("molten-review-ai")).toBe("AI review");
        expect(radarTitleOf("tips")).toBe("Tips");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(radarTitleOf("molten-review-ai")).toBe("Revue IA");
        expect(radarTitleOf("tips")).toBe("Astuces");
    });

    it("names the window and what it does in the interface language (#678)", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        expect(RadarText.window).toBe("Visible area");
        expect(radarWindowLine()).toBe("Visible area — drag to move, click a panel to jump to it");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(RadarText.window).toBe("Zone visible");
        expect(radarWindowLine()).toBe(
            "Zone visible — faites glisser pour la déplacer, cliquez sur un panneau pour y aller"
        );
    });

    it("shows the generic panel name for a view it does not know", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        expect(radarTitleOf("something-new")).toBe("Panel");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(radarTitleOf("something-new")).toBe("Panneau");
    });
});
