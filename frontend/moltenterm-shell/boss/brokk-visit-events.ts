// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What can bring Brokk to fetch the developer (FR-BOSS-009, AC3 and AC4, #2001): the events, how grave each one is, and
// the setting "Quand Brokk vient me chercher" that says, event by event, whether he comes, only counts it on the badge,
// or ignores it. Pure and driven by the clock it is handed, and it knows no surface: the rows To handle, the agent
// states, the bell, the notification center and the downloads all feed it the same way (brokk-visit.ts).
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { DefaultQuietHours, parseClock, QuietHours } from "./brokk-mood";
import { Severity } from "./brokk-queue";

export type BrokkEventKind =
    | "security"
    | "blocked"
    | "error"
    | "ci"
    | "ready"
    | "finished"
    | "downloadfinished"
    | "downloadfailed"
    | "update"
    | "usage";

// A dependency alert is graver when it is critical. Its source is a story of its own (#2004).
export type SecurityLevel = "critical" | "high";

export type BrokkEvent = {
    // What the event is about, stable for as long as it lasts: the same key is the same event, and handling it elsewhere
    // is cancelling that key ("agent:<block>", "ci:<dir>:<number>").
    key: string;
    kind: BrokkEventKind;
    // When it began (Unix ms), 0 when the source does not know: the model then takes the moment it learned of it. A
    // blocked agent's wait is counted from here.
    since: number;
    // Only for a security alert; a missing level reads as high.
    level?: SecurityLevel;
};

export type Coming = "vient" | "badge" | "rien";

// One setting per row of the table in Preferences: the two downloads (finished, failed) share a row.
export type BrokkSettingId =
    | "security"
    | "blocked"
    | "error"
    | "ci"
    | "ready"
    | "finished"
    | "download"
    | "update"
    | "usage";

export const SettingIds: BrokkSettingId[] = [
    "security",
    "blocked",
    "error",
    "ci",
    "ready",
    "finished",
    "download",
    "update",
    "usage",
];

export const SettingOf: Record<BrokkEventKind, BrokkSettingId> = {
    security: "security",
    blocked: "blocked",
    error: "error",
    ci: "ci",
    ready: "ready",
    finished: "finished",
    downloadfinished: "download",
    downloadfailed: "download",
    update: "update",
    usage: "usage",
};

// He comes for a dependency alert and for an agent blocked on the developer; everything else only counts on the badge.
export const DefaultComing: Record<BrokkSettingId, Coming> = {
    security: "vient",
    blocked: "vient",
    error: "badge",
    ci: "badge",
    ready: "badge",
    finished: "badge",
    download: "badge",
    update: "badge",
    usage: "badge",
};

export const ComingValues: Coming[] = ["vient", "badge", "rien"];

// How long an agent may wait for the developer, in minutes, before he comes; and the multiple at which it is grave.
export const BlockedThresholdsMin = [2, 5, 10, 15];
export const DefaultBlockedMin = 5;
export const BlockedGraveFactor = 3;

export type VisitSettings = {
    coming: Record<BrokkSettingId, Coming>;
    blockedMin: number;
    quiet: QuietHours;
    // The master switch: he never comes, only the badge counts.
    never: boolean;
};

export const DefaultVisitSettings: VisitSettings = {
    coming: DefaultComing,
    blockedMin: DefaultBlockedMin,
    quiet: DefaultQuietHours,
    never: false,
};

// The keys of settings.json (pkg/wconfig/settingsconfig.go). Preferences shows them in story #2003.
export const VisitSettingKeys = {
    coming: {
        security: "boss:visitsecurity",
        blocked: "boss:visitblocked",
        error: "boss:visiterror",
        ci: "boss:visitci",
        ready: "boss:visitready",
        finished: "boss:visitfinished",
        download: "boss:visitdownload",
        update: "boss:visitupdate",
        usage: "boss:visitusage",
    } as Record<BrokkSettingId, string>,
    blockedMin: "boss:blockedmin",
    quiet: "boss:quiet",
    quietFrom: "boss:quietfrom",
    quietTo: "boss:quietto",
    never: "boss:nevercome",
};

function comingValue(value: unknown, fallback: Coming): Coming {
    return ComingValues.includes(value as Coming) ? (value as Coming) : fallback;
}

// The settings as the model reads them: a missing or invalid value is its default.
export function visitSettingsOf(read: (key: string) => unknown): VisitSettings {
    const coming = { ...DefaultComing };
    for (const id of SettingIds) {
        coming[id] = comingValue(read(VisitSettingKeys.coming[id]), DefaultComing[id]);
    }
    const blockedMin = Number(read(VisitSettingKeys.blockedMin));
    return {
        coming,
        blockedMin: BlockedThresholdsMin.includes(blockedMin) ? blockedMin : DefaultBlockedMin,
        quiet: {
            on: read(VisitSettingKeys.quiet) !== false,
            from: parseClock(read(VisitSettingKeys.quietFrom)) ?? DefaultQuietHours.from,
            to: parseClock(read(VisitSettingKeys.quietTo)) ?? DefaultQuietHours.to,
        },
        never: read(VisitSettingKeys.never) === true,
    };
}

// The events that never bring him (#2203): an agent that finished is good news its Done card already tells in the
// notifications, so it counts on the badge and nothing more, whatever an older setting says.
const NeverComes: BrokkSettingId[] = ["finished"];

// The choices a row of the table offers: every event but the ones that never bring him can be set to Vient.
export function comingChoices(id: BrokkSettingId): Coming[] {
    return NeverComes.includes(id) ? ComingValues.filter((choice) => choice !== "vient") : ComingValues;
}

export function comingOf(kind: BrokkEventKind, settings: VisitSettings): Coming {
    const id = SettingOf[kind];
    if (id == null) {
        return "rien";
    }
    const value = settings.coming[id];
    return comingChoices(id).includes(value) ? value : "badge";
}

export function blockedThresholdMs(settings: VisitSettings): number {
    return settings.blockedMin * 60 * 1000;
}

// How grave the event is now. A blocked agent turns grave when it is still blocked at three times the threshold.
export function severityOf(event: BrokkEvent, settings: VisitSettings, now: number): Severity {
    switch (event.kind) {
        case "security":
            return event.level === "critical" ? "grave" : "important";
        case "blocked":
            return now - event.since >= BlockedGraveFactor * blockedThresholdMs(settings) ? "grave" : "important";
        case "error":
            return "important";
        case "ready":
        case "finished":
            return "bonne";
        default:
            return "neutre";
    }
}

// Worth a visit already: a blocked agent only once it has waited the threshold. `since` of the others is when it
// happened, which a source's clock may put a little ahead of ours, so it does not delay them.
export function isRaised(event: BrokkEvent, settings: VisitSettings, now: number): boolean {
    return event.kind !== "blocked" || now - event.since >= blockedThresholdMs(settings);
}

// The moments at which the event's answer changes by itself, as time passes.
export function eventMoments(event: BrokkEvent, settings: VisitSettings): number[] {
    return event.kind === "blocked"
        ? [event.since + blockedThresholdMs(settings), event.since + BlockedGraveFactor * blockedThresholdMs(settings)]
        : [];
}
