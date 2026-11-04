// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The foreman's name as Settings and the Library show it: the section that bears it, its search results.

import { getSettingsKeyAtom } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { bossName, BossNameSettingKey } from "./boss-name";

export function useBossName(): string {
    return bossName(useAtomValue(getSettingsKeyAtom(BossNameSettingKey as keyof SettingsType)));
}
