// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { flattenKeys, resolveKey, shippedDictionary } from "../i18n/i18n-core";
import { bossName, bossSettingOn, DefaultBossName, MaxBossNameLength } from "./boss-name";

describe("the name in the interface text (FR-BOSS-001, AC8, AC11)", () => {
    for (const lang of ["en", "fr"]) {
        it(`${lang}.json never carries the foreman's name as a literal, it takes {name}`, () => {
            const dict = shippedDictionary(lang);
            const literals = flattenKeys(dict)
                .filter((key) => /\b(Brokk|Ferrand)\b/.test(resolveKey(dict, key)))
                .map((key) => `${lang} ${key}: ${resolveKey(dict, key)}`);
            expect(literals).toEqual([]);
        });
    }
});

describe("the foreman's name (FR-BOSS-001, AC8)", () => {
    it("is Brokk until the developer names him", () => {
        expect(DefaultBossName).toBe("Brokk");
        expect(bossName(undefined)).toBe("Brokk");
        expect(bossName(null)).toBe("Brokk");
        expect(bossName("")).toBe("Brokk");
        expect(bossName("   ")).toBe("Brokk");
        expect(bossName(42)).toBe("Brokk");
    });

    it("keeps a name the developer set, even the former default", () => {
        expect(bossName("Ferrand")).toBe("Ferrand");
        expect(bossName("Geargrim")).toBe("Geargrim");
    });

    it("is the name typed, on one line, trimmed", () => {
        expect(bossName("Léa")).toBe("Léa");
        expect(bossName("  Gaston  ")).toBe("Gaston");
        expect(bossName("Jean\n Pierre")).toBe("Jean Pierre");
    });

    it("keeps 24 characters at most, counting characters and not UTF-16 units", () => {
        expect(bossName("a".repeat(30))).toBe("a".repeat(MaxBossNameLength));
        const emoji = "🔥".repeat(30);
        expect(Array.from(bossName(emoji))).toHaveLength(MaxBossNameLength);
        expect(bossName(emoji).endsWith("🔥")).toBe(true);
    });

    it("never turns a long name into an empty one", () => {
        expect(bossName(" ".repeat(10) + "x".repeat(40))).toBe("x".repeat(MaxBossNameLength));
    });

    it("shows him unless the developer turned him off", () => {
        expect(bossSettingOn(undefined)).toBe(true);
        expect(bossSettingOn(null)).toBe(true);
        expect(bossSettingOn(true)).toBe(true);
        expect(bossSettingOn(false)).toBe(false);
    });
});
