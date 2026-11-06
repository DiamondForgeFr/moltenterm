// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The foreman's name and the key that shows him (FR-BOSS-001, AC8, AC9; FR-BOSS-009): Brokk by default, renamed in
// Settings. Kept free of imports, since the settings catalog titles its section with the name.

// must match pkg/wconfig/settingsconfig.go
export const BossNameSettingKey = "boss:name";
export const BossShowSettingKey = "boss:show";

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

// A shown setting: on unless the developer turned it off.
export function bossSettingOn(value: unknown): boolean {
    return value !== false;
}
