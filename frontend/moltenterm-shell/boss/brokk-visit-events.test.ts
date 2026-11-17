// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import Schema from "../../../schema/settings.json";
import { BrokkTableGroup } from "./brokk-coming-card";
import type { Severity } from "./brokk-queue";
import {
    BlockedThresholdsMin,
    BrokkEvent,
    BrokkEventKind,
    BrokkSettingId,
    Coming,
    comingOf,
    DefaultBlockedMin,
    DefaultComing,
    DefaultVisitSettings,
    eventMoments,
    isRaised,
    SettingIds,
    SettingOf,
    severityOf,
    VisitSettingKeys,
    visitSettingsOf,
} from "./brokk-visit-events";

const Min = 60_000;
// Ten in the morning, local time.
const Start = new Date(2026, 10, 6, 10, 0, 0).getTime();

function event(kind: BrokkEventKind, extra: Partial<BrokkEvent> = {}): BrokkEvent {
    return { key: `${kind}:1`, kind, since: Start, ...extra };
}

function settingsWith(blockedMin: number) {
    return { ...DefaultVisitSettings, blockedMin };
}

describe("how grave each event is (FR-BOSS-009, AC3)", () => {
    // One row per line of the table of the ticket.
    const table: [string, BrokkEvent, number, Severity][] = [
        ["a critical security alert", event("security", { level: "critical" }), 0, "grave"],
        ["a high security alert", event("security", { level: "high" }), 0, "important"],
        ["a security alert with no level", event("security"), 0, "important"],
        ["an agent blocked for the threshold", event("blocked"), 5 * Min, "important"],
        ["the same agent, still blocked after 3 times the threshold", event("blocked"), 15 * Min, "grave"],
        ["an agent stopped on an error", event("error"), 0, "important"],
        ["a CI failed on my PR", event("ci"), 0, "neutre"],
        ["a PR ready to merge", event("ready"), 0, "bonne"],
        ["an agent finished", event("finished"), 0, "bonne"],
        ["a download finished", event("downloadfinished"), 0, "neutre"],
        ["a download failed", event("downloadfailed"), 0, "neutre"],
        ["an update available", event("update"), 0, "neutre"],
        ["a plan usage above 90 %", event("usage"), 0, "neutre"],
    ];

    it.each(table)("%s is %s", (_name, given, after, expected) => {
        expect(severityOf(given, DefaultVisitSettings, Start + after)).toBe(expected);
    });

    it("turns a blocked agent grave at 3 times the threshold, whatever the threshold is", () => {
        for (const minutes of BlockedThresholdsMin) {
            const settings = settingsWith(minutes);
            const graveAt = 3 * minutes * Min;
            expect(severityOf(event("blocked"), settings, Start + graveAt - 1), `${minutes} min`).toBe("important");
            expect(severityOf(event("blocked"), settings, Start + graveAt), `${minutes} min`).toBe("grave");
        }
    });

    it("waits for the threshold before a blocked agent is worth a visit, and for nothing else", () => {
        for (const minutes of BlockedThresholdsMin) {
            const settings = settingsWith(minutes);
            expect(isRaised(event("blocked"), settings, Start + minutes * Min - 1), `${minutes} min`).toBe(false);
            expect(isRaised(event("blocked"), settings, Start + minutes * Min), `${minutes} min`).toBe(true);
        }
        for (const kind of Object.keys(SettingOf) as BrokkEventKind[]) {
            if (kind !== "blocked") {
                expect(isRaised(event(kind, { since: Start + 10 * Min }), DefaultVisitSettings, Start), kind).toBe(
                    true
                );
            }
        }
    });

    it("names the moments a blocked agent changes by itself, and no other event has any", () => {
        expect(eventMoments(event("blocked"), DefaultVisitSettings)).toEqual([Start + 5 * Min, Start + 15 * Min]);
        expect(eventMoments(event("ci"), DefaultVisitSettings)).toEqual([]);
    });
});

describe("when he comes, by default (FR-BOSS-009, AC4)", () => {
    const table: [BrokkSettingId, Coming][] = [
        ["security", "vient"],
        ["blocked", "vient"],
        ["error", "badge"],
        ["ci", "badge"],
        ["ready", "badge"],
        ["finished", "badge"],
        ["download", "badge"],
        ["update", "badge"],
        // No card lists it, so no badge counts it (#2213).
        ["usage", "rien"],
    ];

    it.each(table)("%s is %s", (id, expected) => {
        expect(DefaultComing[id]).toBe(expected);
        expect(DefaultVisitSettings.coming[id]).toBe(expected);
    });

    it("has a default for every setting and no other", () => {
        expect(Object.keys(DefaultComing).sort()).toEqual([...SettingIds].sort());
    });

    it("is read per event kind, the two downloads sharing one setting", () => {
        expect(comingOf("security", DefaultVisitSettings)).toBe("vient");
        expect(comingOf("blocked", DefaultVisitSettings)).toBe("vient");
        expect(comingOf("ci", DefaultVisitSettings)).toBe("badge");
        const both = { ...DefaultVisitSettings, coming: { ...DefaultComing, download: "rien" as Coming } };
        expect(comingOf("downloadfinished", both)).toBe("rien");
        expect(comingOf("downloadfailed", both)).toBe("rien");
        expect(comingOf("update", both)).toBe("badge");
    });

    it("ignores an event of a kind it does not know", () => {
        expect(comingOf("nothing" as BrokkEventKind, DefaultVisitSettings)).toBe("rien");
    });

    it("has a 5 min threshold, quiet hours from 22:00 to 08:00 and no master switch", () => {
        expect(DefaultBlockedMin).toBe(5);
        expect(DefaultVisitSettings.blockedMin).toBe(5);
        expect(DefaultVisitSettings.quiet).toEqual({ on: true, from: 22 * 60, to: 8 * 60 });
        expect(DefaultVisitSettings.never).toBe(false);
        expect(BlockedThresholdsMin).toEqual([2, 5, 10, 15]);
    });
});

describe("reading the settings (FR-BOSS-009, AC4)", () => {
    function read(values: Record<string, unknown>) {
        return visitSettingsOf((key) => values[key]);
    }

    it("reads the defaults when nothing is set", () => {
        expect(read({})).toEqual(DefaultVisitSettings);
    });

    it("reads each event's choice", () => {
        const settings = read({
            [VisitSettingKeys.coming.ci]: "vient",
            [VisitSettingKeys.coming.security]: "badge",
            [VisitSettingKeys.coming.usage]: "rien",
        });
        expect(settings.coming.ci).toBe("vient");
        expect(settings.coming.security).toBe("badge");
        expect(settings.coming.usage).toBe("rien");
        expect(settings.coming.blocked).toBe("vient");
    });

    it("reads an invalid choice as the default of that event", () => {
        const settings = read({
            [VisitSettingKeys.coming.security]: "come",
            [VisitSettingKeys.coming.ci]: 3,
            [VisitSettingKeys.coming.ready]: null,
        });
        expect(settings.coming.security).toBe("vient");
        expect(settings.coming.ci).toBe("badge");
        expect(settings.coming.ready).toBe("badge");
    });

    it("reads the threshold when it is one of 2, 5, 10 and 15, and 5 for anything else", () => {
        for (const minutes of BlockedThresholdsMin) {
            expect(read({ [VisitSettingKeys.blockedMin]: minutes }).blockedMin).toBe(minutes);
        }
        for (const bad of [0, 1, 7, 20, -5, "ten", null, 5.5]) {
            expect(read({ [VisitSettingKeys.blockedMin]: bad }).blockedMin, String(bad)).toBe(5);
        }
    });

    it("reads quiet hours on unless they are turned off, and the hours when they are valid", () => {
        expect(read({}).quiet.on).toBe(true);
        expect(read({ [VisitSettingKeys.quiet]: false }).quiet.on).toBe(false);
        expect(read({ [VisitSettingKeys.quiet]: true }).quiet.on).toBe(true);
        const hours = read({ [VisitSettingKeys.quietFrom]: "23:30", [VisitSettingKeys.quietTo]: "7:15" }).quiet;
        expect([hours.from, hours.to]).toEqual([23 * 60 + 30, 7 * 60 + 15]);
        for (const bad of ["24:00", "9", "ab:cd", "10:75", "", 22, null]) {
            const quiet = read({ [VisitSettingKeys.quietFrom]: bad, [VisitSettingKeys.quietTo]: bad }).quiet;
            expect([quiet.from, quiet.to], String(bad)).toEqual([22 * 60, 8 * 60]);
        }
    });

    it("reads the master switch on only when it is true", () => {
        expect(read({ [VisitSettingKeys.never]: true }).never).toBe(true);
        for (const other of [false, "true", 1, null]) {
            expect(read({ [VisitSettingKeys.never]: other }).never, String(other)).toBe(false);
        }
    });

    it("does not share its defaults with what it returns", () => {
        const settings = read({});
        settings.coming.ci = "rien";
        expect(DefaultComing.ci).toBe("badge");
    });
});

describe("the settings keys exist (add-config)", () => {
    const properties = Schema.$defs.SettingsType.properties as Record<string, { type: string; enum?: unknown[] }>;
    const keys = [
        ...Object.values(VisitSettingKeys.coming),
        VisitSettingKeys.blockedMin,
        VisitSettingKeys.quiet,
        VisitSettingKeys.quietFrom,
        VisitSettingKeys.quietTo,
        VisitSettingKeys.never,
    ];

    it.each(keys)("%s is a key of settings.json", (key) => {
        expect(properties[key], key).toBeDefined();
    });

    it("allows the three choices on each event's key", () => {
        for (const key of Object.values(VisitSettingKeys.coming)) {
            expect(properties[key].enum, key).toEqual(["vient", "badge", "rien"]);
        }
    });

    it("allows the four thresholds on its key, as integers", () => {
        expect(properties[VisitSettingKeys.blockedMin].type).toBe("integer");
        expect(properties[VisitSettingKeys.blockedMin].enum).toEqual(BlockedThresholdsMin);
    });

    it("shows the keys in the Brokk section's one group, the table of Preferences (#2003)", () => {
        for (const key of keys) {
            const meta = (
                properties[key] as { "x-moltenterm"?: { hidden?: boolean; section?: string; group?: string } }
            )["x-moltenterm"];
            expect(meta?.hidden, key).toBeFalsy();
            expect(meta?.section, key).toBe("boss");
            expect(meta?.group, key).toBe(BrokkTableGroup);
        }
    });
});
