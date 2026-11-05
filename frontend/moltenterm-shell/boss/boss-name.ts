// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The foreman's name and the keys of his bubble (FR-BOSS-001, AC8, AC9): Brokk by default, renamed in Settings. Kept
// free of imports, since the settings catalog titles its section with the name.

// must match pkg/wconfig/settingsconfig.go
export const BossNameSettingKey = "boss:name";
export const BossShowSettingKey = "boss:show";
export const BossCollapseOnTypeSettingKey = "boss:collapseontype";

// The window's meta key of the bubble's place and manual collapse (DS-BOSS-001).
export const BossBubbleMetaKey = "molten:bossbubble";

export const DefaultBossName = "Brokk";
export const MaxBossNameLength = 24;

// The name as every text shows it: 1 to 24 characters (counted as characters, not UTF-16 units), on one line; Brokk
// when nothing was typed.
export function bossName(raw: unknown): string {
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (text === "") {
        return DefaultBossName;
    }
    return Array.from(text).slice(0, MaxBossNameLength).join("").trim() || DefaultBossName;
}

// The pennant's letter: the first character of the name, upper case.
export function bossInitial(name: string): string {
    const first = Array.from(bossName(name))[0] ?? DefaultBossName[0];
    return first.toLocaleUpperCase();
}

// A shown setting: on unless the developer turned it off.
export function bossSettingOn(value: unknown): boolean {
    return value !== false;
}
