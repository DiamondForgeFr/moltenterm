// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage readings the peek tells (FR-BOSS-001, AC7, FR-SHELL-027): wavesrv publishes a companion's reading as
// molten:companionusage, and this keeps the latest one per agent. It asks for nothing: the peek says "when a reading
// exists", and no reading means no line, with no call and no polling.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, PrimitiveAtom } from "jotai";
import type { CompanionUsageInfo, UsageSnapshot } from "../companion/companion-gauges-model";
import { CompanionUsageEvent } from "../companion/companion-model";

export type UsageReadings = Record<string, UsageSnapshot>;

export const UsageReadingsAtom = atom({}) as PrimitiveAtom<UsageReadings>;

// A reading replaces the agent's older one; gauges turned off or gone take it away, since the peek must not tell a
// level the developer no longer shares.
export function applyUsageReading(current: UsageReadings, info: CompanionUsageInfo): UsageReadings {
    const agent = info?.agent;
    if (!agent) {
        return current;
    }
    const snapshot = info.gauges === "enabled" ? info.snapshot : undefined;
    if (snapshot == null) {
        if (current[agent] == null) {
            return current;
        }
        const { [agent]: _gone, ...rest } = current;
        return rest;
    }
    if ((current[agent]?.readat ?? 0) > (snapshot.readat ?? 0)) {
        return current;
    }
    return { ...current, [agent]: snapshot };
}

let users = 0;
let unsubscribe: () => void = null;

// One subscription for every user of the readings in this window.
export function startUsageReadings(): () => void {
    users++;
    if (unsubscribe == null) {
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: CompanionUsageEvent as WaveEventName,
                handler: (event) => {
                    const current = globalStore.get(UsageReadingsAtom);
                    const next = applyUsageReading(current, event.data as CompanionUsageInfo);
                    if (next !== current) {
                        globalStore.set(UsageReadingsAtom, next);
                    }
                },
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("boss usage: no event bus", e);
        }
    }
    let stopped = false;
    return () => {
        if (stopped) {
            return;
        }
        stopped = true;
        users--;
        if (users === 0 && unsubscribe != null) {
            unsubscribe();
            unsubscribe = null;
        }
    };
}
