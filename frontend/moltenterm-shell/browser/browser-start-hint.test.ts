// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { startPageHintKey } from "./browser-start-hint";

function lookup(locale: any, key: string): string {
    return key.split(".").reduce((o, k) => o?.[k], locale);
}

describe("start page hint (#1643)", () => {
    it("asks for a folder when the workspace has none", () => {
        expect(startPageHintKey("", false)).toBe("browser.start.hintNoProject");
    });

    it("names GitHub only for a repository", () => {
        expect(startPageHintKey("/p", true)).toBe("browser.start.hintProject");
        expect(startPageHintKey("/notes", false)).toBe("browser.start.hintFolder");
    });

    it("says nothing about code, repositories or GitHub without a repository", () => {
        for (const key of ["browser.start.hintFolder", "browser.start.hintNoProject"]) {
            for (const locale of [en, fr]) {
                const text = lookup(locale, key);
                expect(text).toBeTruthy();
                expect(text).not.toMatch(/GitHub|code|dépôt|repository/i);
            }
        }
    });
});
