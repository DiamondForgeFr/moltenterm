// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view's menu carries no "Flag tab" (#1287): a view has its icon and name, and MoltenTerm shows no tab bar. Its
// background item says it applies to this view.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";

const menuSrc = fs.readFileSync(path.resolve(__dirname, "../../app/tab/tabcontextmenu.ts"), "utf8");
const sidebarSrc = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");

describe("the view menu's tab leftovers (#1287)", () => {
    it("offers no flag and draws none", () => {
        expect(menuSrc).not.toContain("tab:flagcolor");
        expect(menuSrc).not.toContain("wave.tab.flag");
        expect(sidebarSrc).not.toContain("tab:flagcolor");
        for (const dict of [en, fr] as any[]) {
            expect(Object.keys(dict.wave.tab).filter((k) => k.startsWith("flag"))).toEqual([]);
        }
    });

    it("names the background item after the view", () => {
        expect(en.wave.tab.backgrounds).toBe("View background…");
        expect(fr.wave.tab.backgrounds).toBe("Arrière-plan de la vue…");
        expect(menuSrc).toContain('t("wave.tab.backgrounds")');
    });
});
