// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { bossInitial, bossName, bossSettingOn, DefaultBossName, MaxBossNameLength } from "./boss-name";

describe("the foreman's name (FR-BOSS-001, AC8)", () => {
    it("is Ferrand until the developer names him", () => {
        expect(DefaultBossName).toBe("Ferrand");
        expect(bossName(undefined)).toBe("Ferrand");
        expect(bossName(null)).toBe("Ferrand");
        expect(bossName("")).toBe("Ferrand");
        expect(bossName("   ")).toBe("Ferrand");
        expect(bossName(42)).toBe("Ferrand");
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

    it("has the first letter of the name, in capitals, as its initial", () => {
        expect(bossInitial("Ferrand")).toBe("F");
        expect(bossInitial("léa")).toBe("L");
        expect(bossInitial("  émile")).toBe("É");
        expect(bossInitial("")).toBe("F");
        expect(bossInitial("🔥 forge")).toBe("🔥");
    });

    it("shows the bubble and collapses on typing unless the developer turned them off", () => {
        expect(bossSettingOn(undefined)).toBe(true);
        expect(bossSettingOn(null)).toBe(true);
        expect(bossSettingOn(true)).toBe(true);
        expect(bossSettingOn(false)).toBe(false);
    });
});
