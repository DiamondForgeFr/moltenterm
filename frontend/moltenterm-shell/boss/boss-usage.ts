// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage readings the peek tells (FR-BOSS-001, AC7, FR-SHELL-027): wavesrv publishes a companion's reading as
// molten:companionusage, and this keeps the latest one per agent. A plan is the account's, not a terminal's (#2074,
// FR-SHELL-029): wavesrv also publishes a global reading without a block, asked for once when the readings start.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import type { CompanionUsageInfo, UsageSnapshot } from "../companion/companion-gauges-model";
import { CompanionRoute, CompanionUsageEvent } from "../companion/companion-model";

export type UsageReadings = Record<string, UsageSnapshot>;
// Why an agent's global reading cannot be read, by agent: the weekly usage says so instead of leaving it out.
export type UsageUnreadable = Record<string, string>;

export const UsageReadingsAtom = atom({}) as PrimitiveAtom<UsageReadings>;
export const UsageUnreadableAtom = atom({}) as PrimitiveAtom<UsageUnreadable>;

export const CompanionUsageGlobalCommand = "moltencompanionusageglobal";
const GlobalRpcTimeoutMs = 12000;

function without<T>(current: Record<string, T>, agent: string): Record<string, T> {
    if (current[agent] == null) {
        return current;
    }
    const { [agent]: _gone, ...rest } = current;
    return rest;
}

// A reading replaces the agent's older one. Gauges turned off take it away, since the peek must not tell a level the
// developer no longer shares; one terminal's read failing does not, the plan's reading still holds until its reset.
export function applyUsageReading(current: UsageReadings, info: CompanionUsageInfo): UsageReadings {
    const agent = info?.agent;
    if (!agent) {
        return current;
    }
    if (info.gauges === "off") {
        return without(current, agent);
    }
    const snapshot = info.gauges === "enabled" ? info.snapshot : undefined;
    if (snapshot == null) {
        return current;
    }
    if ((current[agent]?.readat ?? 0) > (snapshot.readat ?? 0)) {
        return current;
    }
    return { ...current, [agent]: snapshot };
}

// Only the global reading tells that an agent cannot be read at all; any reading, or gauges off, clears it.
export function applyUnreadable(current: UsageUnreadable, info: CompanionUsageInfo): UsageUnreadable {
    const agent = info?.agent;
    if (!agent) {
        return current;
    }
    if (info.global && info.gauges === "unavailable") {
        const reason = info.reason || "failed";
        return current[agent] === reason ? current : { ...current, [agent]: reason };
    }
    if (info.gauges === "off" || (info.gauges === "enabled" && info.snapshot != null)) {
        return without(current, agent);
    }
    return current;
}

function applyInfo(info: CompanionUsageInfo) {
    const readings = globalStore.get(UsageReadingsAtom);
    const nextReadings = applyUsageReading(readings, info);
    if (nextReadings !== readings) {
        globalStore.set(UsageReadingsAtom, nextReadings);
    }
    const unreadable = globalStore.get(UsageUnreadableAtom);
    const nextUnreadable = applyUnreadable(unreadable, info);
    if (nextUnreadable !== unreadable) {
        globalStore.set(UsageUnreadableAtom, nextUnreadable);
    }
}

// The global readings now: an app-server may run only for a window that shows (NFR-SHELL-013).
async function askGlobal() {
    try {
        const fetch = typeof document !== "undefined" && document.visibilityState === "visible";
        const infos: CompanionUsageInfo[] = await TabRpcClient.wshRpcCall(
            CompanionUsageGlobalCommand,
            { fetch },
            { route: CompanionRoute, timeout: GlobalRpcTimeoutMs }
        );
        (infos ?? []).forEach(applyInfo);
    } catch (e) {
        // The preview server has no companion route.
        console.log("boss usage: no global reading", e);
    }
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
                handler: (event) => applyInfo(event.data as CompanionUsageInfo),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("boss usage: no event bus", e);
        }
        askGlobal();
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
