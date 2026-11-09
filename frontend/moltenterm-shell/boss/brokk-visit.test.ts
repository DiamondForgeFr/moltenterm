// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AfterActionMs, AfterLeaveMs, GateEvent } from "./brokk-gate";
import type { Severity } from "./brokk-queue";
import { SeverityExpression } from "./brokk-queue";
import {
    badgeCount,
    brokkAfter,
    BrokkInput,
    BrokkModel,
    BrokkView,
    EmptyVisits,
    InitialBrokk,
    SnoozeChoiceId,
    snoozeChoices,
    snoozeMenuOf,
    snoozeUntil,
    tellable,
} from "./brokk-visit";
import {
    BrokkEvent,
    BrokkEventKind,
    BrokkSettingId,
    Coming,
    DefaultVisitSettings,
    SettingIds,
    VisitSettings,
} from "./brokk-visit-events";

const Min = 60_000;
const Hour = 60 * Min;

// Local time on the day of the other Brokk tests, so that the clock-time rules do not depend on the machine's zone.
function at(hour: number, minute = 0, day = 0): number {
    return new Date(2026, 10, 6 + day, hour, minute, 0, 0).getTime();
}

const T0 = at(10);

// Every event brings him, to see how several of them make one visit.
const AllCome: VisitSettings = {
    ...DefaultVisitSettings,
    coming: Object.fromEntries(SettingIds.map((id) => [id, "vient"])) as Record<BrokkSettingId, Coming>,
};

function event(kind: BrokkEventKind, key: string, since = T0, extra: Partial<BrokkEvent> = {}): BrokkEvent {
    return { key, kind, since, ...extra };
}

const Critical = event("security", "sec:critical", T0, { level: "critical" });
const High = event("security", "sec:high", T0, { level: "high" });

// The model is driven by a clock the test moves by hand: nothing here waits for real time.
function drive(settings: VisitSettings = DefaultVisitSettings) {
    const world = {
        model: { ...InitialBrokk, settings } as BrokkModel,
        view: null as BrokkView,
        wakeAt: null as number,
        step(input: BrokkInput, now: number) {
            const step = brokkAfter(world.model, input, now);
            world.model = step.model;
            world.view = step.view;
            world.wakeAt = step.wakeAt;
            return step;
        },
        raise(given: BrokkEvent, now: number, source?: string) {
            return world.step({ type: "raise", event: given, source }, now);
        },
        gate(given: GateEvent, now: number) {
            return world.step({ type: "gate", event: given }, now);
        },
        tick(now: number) {
            return world.step({ type: "tick" }, now);
        },
    };
    world.step({ type: "tick" }, T0 - 1);
    return world;
}

describe("the options of Plus tard (FR-BOSS-009, AC7)", () => {
    const table: [Severity, SnoozeChoiceId[], SnoozeChoiceId][] = [
        ["grave", ["5min", "15min", "1h"], "5min"],
        ["important", ["15min", "1h", "tonight"], "15min"],
        ["neutre", ["1h", "tonight", "tomorrow"], "1h"],
        ["bonne", ["1h", "tonight", "tomorrow"], "1h"],
    ];

    it.each(table)("a %s visit offers %j and Escape means %s", (severity, choices, escape) => {
        expect(snoozeMenuOf(severity)).toEqual({ choices, escape });
        expect(snoozeMenuOf(severity).choices[0]).toBe(escape);
    });

    it("counts the short delays from the moment it is asked", () => {
        expect(snoozeUntil("5min", T0)).toBe(T0 + 5 * Min);
        expect(snoozeUntil("15min", T0)).toBe(T0 + 15 * Min);
        expect(snoozeUntil("1h", T0)).toBe(T0 + Hour);
    });

    // This evening is 18:00 and tomorrow morning is 09:00; a clock time closer than an hour is not offered.
    const clock: [string, number, number, number][] = [
        ["10:00", at(10), at(18), at(9, 0, 1)],
        ["16:59", at(16, 59), at(18), at(9, 0, 1)],
        ["17:00, an hour from the evening", at(17), null, at(9, 0, 1)],
        ["18:30, the evening has begun", at(18, 30), null, at(9, 0, 1)],
        ["23:00", at(23), null, at(9, 0, 1)],
        ["02:00, asked in the night", at(2), at(18), at(9)],
        ["07:59", at(7, 59), at(18), at(9)],
        ["08:00, an hour from the morning", at(8), at(18), at(9, 0, 1)],
    ];

    it.each(clock)("at %s, this evening and tomorrow morning end when expected", (_name, now, tonight, tomorrow) => {
        expect(snoozeUntil("tonight", now)).toBe(tonight);
        expect(snoozeUntil("tomorrow", now)).toBe(tomorrow);
    });

    it("lists the choices with their end, and leaves out this evening once it is too close", () => {
        expect(snoozeChoices("important", at(10))).toEqual([
            { id: "15min", until: at(10, 15) },
            { id: "1h", until: at(11) },
            { id: "tonight", until: at(18) },
        ]);
        expect(snoozeChoices("neutre", at(18, 30)).map((choice) => choice.id)).toEqual(["1h", "tomorrow"]);
        expect(snoozeChoices("grave", at(18, 30)).map((choice) => choice.id)).toEqual(["5min", "15min", "1h"]);
    });
});

describe("one visit at a time (FR-BOSS-009, AC5)", () => {
    it("comes for an event set to Vient, with the face of its severity", () => {
        const w = drive();
        w.raise(High, T0);
        expect(w.view.visit).toEqual({
            severity: "important",
            expression: "doubtful",
            keys: ["sec:high"],
            count: 1,
        });
    });

    it("comes for a critical alert with a frown", () => {
        const w = drive();
        w.raise(Critical, T0);
        expect(w.view.visit).toMatchObject({ severity: "grave", expression: "frown" });
    });

    it("makes one visit of several pending events, the gravest first", () => {
        const w = drive(AllCome);
        w.gate({ type: "enter" }, T0);
        w.raise(event("ci", "ci:/p:1", T0 + 1), T0 + 1);
        w.raise(Critical, T0 + 2);
        w.raise(event("error", "agent:a", T0 + 3), T0 + 3);
        expect(w.view.visit).toBeNull();
        w.gate({ type: "leave" }, T0 + 10);
        w.tick(T0 + 10 + AfterLeaveMs);
        expect(w.view.visit).toEqual({
            severity: "grave",
            expression: "frown",
            keys: ["sec:critical", "agent:a", "ci:/p:1"],
            count: 3,
        });
    });

    it("orders events of the same gravity by how long they have waited", () => {
        const w = drive(AllCome);
        w.gate({ type: "enter" }, T0);
        w.raise(event("error", "agent:late", T0 + 5), T0 + 5);
        w.raise(event("error", "agent:early", T0 + 1), T0 + 6);
        w.gate({ type: "leave" }, T0 + 7);
        w.tick(T0 + 7 + AfterLeaveMs);
        expect(w.view.visit.keys).toEqual(["agent:early", "agent:late"]);
    });

    describe("the most severe pending event sets his face", () => {
        const table: [string, BrokkEvent[], Severity][] = [
            ["grave", [event("security", "a", T0, { level: "critical" })], "grave"],
            ["important", [event("error", "a")], "important"],
            ["neutre", [event("ci", "a")], "neutre"],
            ["bonne", [event("ready", "a")], "bonne"],
            ["a call and good news", [event("ready", "a"), event("update", "b")], "neutre"],
            ["an error and a call", [event("ci", "a"), event("error", "b")], "important"],
            ["everything", [event("ready", "a"), event("ci", "b"), event("error", "c"), Critical], "grave"],
        ];

        it.each(table)("%s", (_name, events, severity) => {
            const w = drive(AllCome);
            w.gate({ type: "enter" }, T0);
            events.forEach((given, i) => w.raise(given, T0 + i));
            w.gate({ type: "leave" }, T0 + 100);
            w.tick(T0 + 100 + AfterLeaveMs);
            expect(w.view.visit.severity).toBe(severity);
            expect(w.view.visit.expression).toBe(SeverityExpression[severity]);
        });

        it("is a frown for grave, doubtful for important, a call for neutre and a smile for bonne", () => {
            expect(SeverityExpression).toEqual({
                grave: "frown",
                important: "doubtful",
                neutre: "call",
                bonne: "smile",
            });
        });
    });

    it("lets an event that comes while he is there join the visit and change his face", () => {
        const w = drive(AllCome);
        w.raise(event("ready", "pr:1"), T0);
        expect(w.view.visit).toMatchObject({ expression: "smile", count: 1 });
        w.raise(event("ci", "ci:1"), T0 + 1);
        expect(w.view.visit).toMatchObject({ expression: "call", count: 2 });
        w.raise(Critical, T0 + 2);
        expect(w.view.visit).toMatchObject({ expression: "frown", count: 3 });
        w.raise(event("update", "update:1"), T0 + 3);
        expect(w.view.visit).toMatchObject({ expression: "frown", count: 4 });
    });

    it("does not come for an event set to Badge, which only the badge counts", () => {
        const w = drive();
        w.raise(event("ci", "ci:/p:1"), T0);
        w.raise(event("ready", "ready:/p:2"), T0 + 1);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(false);
        expect(w.view.badge).toBe(2);
        expect(w.wakeAt).toBeNull();
    });

    it("does not come, and does not count, for an event set to Rien", () => {
        const w = drive({ ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, security: "rien" } });
        w.raise(Critical, T0);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(false);
        expect(w.view.badge).toBe(0);
    });

    it("follows the setting as it changes: a pending event set to Vient later brings him", () => {
        const w = drive();
        w.raise(event("ci", "ci:/p:1"), T0);
        expect(w.view.visit).toBeNull();
        w.step({ type: "settings", settings: AllCome }, T0 + 1);
        expect(w.view.visit).toMatchObject({ severity: "neutre", expression: "call" });
        w.step({ type: "settings", settings: DefaultVisitSettings }, T0 + 2);
        expect(w.view.visit).toBeNull();
        expect(w.view.badge).toBe(1);
    });

    it("counts the events of every kind but Rien in the badge, whether or not they bring him", () => {
        const w = drive();
        const kinds: BrokkEventKind[] = [
            "security",
            "blocked",
            "error",
            "ci",
            "ready",
            "finished",
            "downloadfinished",
            "downloadfailed",
            "update",
            "usage",
        ];
        kinds.forEach((kind, i) => w.raise(event(kind, `${kind}:1`), T0 + i));
        expect(w.view.badge).toBe(10);
        w.step(
            {
                type: "settings",
                settings: { ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, download: "rien" } },
            },
            T0 + 20
        );
        expect(w.view.badge).toBe(8);
        expect(badgeCount(EmptyVisits, DefaultVisitSettings)).toBe(0);
    });

    it("knows an event raised twice as one", () => {
        const w = drive();
        w.raise(High, T0);
        const before = w.model;
        const again = w.raise(High, T0 + 5);
        expect(again.model).toBe(before);
        expect(w.view.badge).toBe(1);
        expect(w.view.visit.count).toBe(1);
    });

    it("keeps when an event began, however often it is raised again", () => {
        const w = drive();
        w.raise(event("error", "agent:a", T0), T0 + Min);
        w.raise(event("error", "agent:a", T0 + 30 * Min), T0 + 31 * Min);
        expect(w.model.visits.events["agent:a"].event.since).toBe(T0);
    });

    it("takes the moment it learned of an event whose source does not know when it began", () => {
        const w = drive();
        w.raise(event("error", "agent:a", 0), T0 + 3 * Min);
        expect(w.model.visits.events["agent:a"].event.since).toBe(T0 + 3 * Min);
    });
});

describe("an agent blocked on the developer (FR-BOSS-009, AC3)", () => {
    function blocked(since = T0, key = "agent:olivia"): BrokkEvent {
        return event("blocked", key, since);
    }

    it("is only counted until it has waited the threshold, then he comes, doubtful", () => {
        const w = drive();
        w.raise(blocked(), T0);
        expect(w.view.visit).toBeNull();
        expect(w.view.badge).toBe(1);
        expect(w.wakeAt).toBe(T0 + 5 * Min);
        w.tick(T0 + 5 * Min - 1);
        expect(w.view.visit).toBeNull();
        w.tick(T0 + 5 * Min);
        expect(w.view.visit).toMatchObject({ severity: "important", expression: "doubtful", keys: ["agent:olivia"] });
    });

    it("turns the visit grave when the agent is still blocked at 3 times the threshold, while he is there", () => {
        const w = drive();
        w.raise(blocked(), T0);
        w.tick(T0 + 5 * Min);
        expect(w.wakeAt).toBe(T0 + 15 * Min);
        w.tick(T0 + 15 * Min - 1);
        expect(w.view.visit.expression).toBe("doubtful");
        w.tick(T0 + 15 * Min);
        expect(w.view.visit).toMatchObject({ severity: "grave", expression: "frown" });
    });

    it("comes at once, grave, for an agent that was blocked for long before it was heard of", () => {
        const w = drive();
        w.raise(blocked(T0 - 20 * Min), T0);
        expect(w.view.visit).toMatchObject({ severity: "grave", expression: "frown" });
    });

    it("follows the threshold setting", () => {
        for (const minutes of [2, 10, 15]) {
            const w = drive({ ...DefaultVisitSettings, blockedMin: minutes });
            w.raise(blocked(), T0);
            expect(w.wakeAt, `${minutes} min`).toBe(T0 + minutes * Min);
            w.tick(T0 + minutes * Min - 1);
            expect(w.view.visit, `${minutes} min`).toBeNull();
            w.tick(T0 + minutes * Min);
            expect(w.view.visit?.severity, `${minutes} min`).toBe("important");
            w.tick(T0 + 3 * minutes * Min);
            expect(w.view.visit?.severity, `${minutes} min`).toBe("grave");
        }
    });

    it("does not come for a blocked agent set to Badge or Rien", () => {
        for (const choice of ["badge", "rien"] as Coming[]) {
            const w = drive({ ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, blocked: choice } });
            w.raise(blocked(T0 - 20 * Min), T0);
            expect(w.view.visit, choice).toBeNull();
            expect(w.wakeAt, choice).toBeNull();
        }
    });
});

describe("an event handled elsewhere cancels it (FR-BOSS-009, AC5)", () => {
    it("takes it out of the visit, and cancels the visit when none is left", () => {
        const w = drive(AllCome);
        w.raise(Critical, T0);
        w.raise(event("error", "agent:a"), T0 + 1);
        expect(w.view.visit).toMatchObject({ expression: "frown", count: 2 });
        w.step({ type: "cancel", key: "sec:critical" }, T0 + 2);
        expect(w.view.visit).toMatchObject({ expression: "doubtful", keys: ["agent:a"], count: 1 });
        w.step({ type: "cancel", key: "agent:a" }, T0 + 3);
        expect(w.view.visit).toBeNull();
        expect(w.model.visits.shown).toBe(false);
        expect(w.view.badge).toBe(0);
    });

    it("cancels an event that waits for the pointer, so that he does not come for it", () => {
        const w = drive();
        w.gate({ type: "enter" }, T0);
        w.raise(High, T0 + 1);
        expect(w.view.cue).toBe(true);
        w.step({ type: "cancel", key: "sec:high" }, T0 + 2);
        expect(w.view.cue).toBe(false);
        w.gate({ type: "leave" }, T0 + 3);
        w.tick(T0 + 3 + AfterLeaveMs);
        expect(w.view.visit).toBeNull();
    });

    it("cancels an agent answered before it was blocked long enough", () => {
        const w = drive();
        w.raise(event("blocked", "agent:a"), T0);
        w.step({ type: "cancel", key: "agent:a" }, T0 + 2 * Min);
        w.tick(T0 + 5 * Min);
        expect(w.view.visit).toBeNull();
        expect(w.view.badge).toBe(0);
        expect(w.wakeAt).toBeNull();
    });

    it("ignores the cancelling of an event it does not know", () => {
        const w = drive();
        w.raise(High, T0);
        const before = w.model;
        expect(w.step({ type: "cancel", key: "nothing" }, T0 + 1).model).toBe(before);
    });

    it("lets a source that gives its whole set cancel what it no longer lists, and only its own", () => {
        const w = drive(AllCome);
        w.gate({ type: "enter" }, T0);
        w.step({ type: "sync", source: "rows", events: [event("ci", "ci:1"), event("ready", "ready:2")] }, T0 + 1);
        w.raise(event("downloadfailed", "dl:1"), T0 + 2, "downloads");
        expect(w.view.badge).toBe(3);
        w.step({ type: "sync", source: "rows", events: [event("ci", "ci:1")] }, T0 + 3);
        expect(w.view.badge).toBe(2);
        expect(Object.keys(w.model.visits.events).sort()).toEqual(["ci:1", "dl:1"]);
        w.step({ type: "sync", source: "rows", events: [] }, T0 + 4);
        expect(Object.keys(w.model.visits.events)).toEqual(["dl:1"]);
    });

    it("knows a whole set it already holds as it is", () => {
        const w = drive();
        const rows = [event("ci", "ci:1"), event("error", "agent:a")];
        w.step({ type: "sync", source: "rows", events: rows }, T0);
        const before = w.model;
        expect(w.step({ type: "sync", source: "rows", events: rows }, T0 + 10).model).toBe(before);
    });

    it("tells again an event that comes back after it was cancelled", () => {
        const w = drive();
        w.raise(High, T0);
        w.step({ type: "open" }, T0 + 1);
        w.step({ type: "cancel", key: "sec:high" }, T0 + 2);
        w.raise(High, T0 + 3);
        expect(w.view.visit).toMatchObject({ keys: ["sec:high"] });
    });
});

describe("Répondre: opening the panel tells what waits (FR-BOSS-009, AC5)", () => {
    it("ends the visit but keeps the events, counted and listed", () => {
        const w = drive();
        w.raise(High, T0);
        w.step({ type: "open" }, T0 + 1);
        expect(w.view.visit).toBeNull();
        expect(w.view.badge).toBe(1);
        expect(w.view.cue).toBe(false);
        expect(tellable(w.model.visits, w.model.settings, T0 + 2)).toEqual([]);
        expect(w.wakeAt).toBeNull();
    });

    it("does not come again for what was told, even for a long time", () => {
        const w = drive();
        w.raise(High, T0);
        w.step({ type: "open" }, T0 + 1);
        w.tick(T0 + 24 * Hour);
        expect(w.view.visit).toBeNull();
    });

    it("comes for a new event, once", () => {
        const w = drive();
        w.raise(High, T0);
        w.step({ type: "open" }, T0 + 1);
        w.raise(Critical, T0 + 2);
        expect(w.view.visit).toMatchObject({ keys: ["sec:critical"], count: 1 });
    });

    it("comes again for an event told as important when it grows grave, and for no other change", () => {
        const w = drive();
        w.raise(event("blocked", "agent:a"), T0);
        w.tick(T0 + 5 * Min);
        expect(w.view.visit.severity).toBe("important");
        w.step({ type: "open" }, T0 + 6 * Min);
        w.tick(T0 + 14 * Min);
        expect(w.view.visit).toBeNull();
        w.tick(T0 + 15 * Min);
        expect(w.view.visit).toMatchObject({ severity: "grave", expression: "frown", keys: ["agent:a"] });
        w.step({ type: "open" }, T0 + 16 * Min);
        w.tick(T0 + 10 * Hour);
        expect(w.view.visit).toBeNull();
    });

    it("tells an event again when its kind changes under its key: an agent that waited, now in error", () => {
        const w = drive(AllCome);
        w.raise(event("blocked", "agent:a", T0 - 10 * Min), T0);
        w.step({ type: "open" }, T0 + 1);
        w.raise(event("error", "agent:a", T0 + 2), T0 + 2);
        expect(w.view.visit).toMatchObject({ severity: "important", keys: ["agent:a"] });
    });

    it("opens from the avatar with nothing up as well, and tells what was waiting for the pointer", () => {
        const w = drive();
        w.gate({ type: "enter" }, T0);
        w.raise(High, T0 + 1);
        w.step({ type: "open" }, T0 + 2);
        w.gate({ type: "leave" }, T0 + 3);
        w.tick(T0 + 3 + AfterLeaveMs);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(false);
    });
});

describe("Plus tard (FR-BOSS-009, AC7)", () => {
    it("sends him back and keeps the events pending, until the delay ends", () => {
        const w = drive();
        w.raise(Critical, T0);
        w.step({ type: "later", choice: "15min" }, T0 + 1000);
        expect(w.view.visit).toBeNull();
        expect(w.view.laterUntil).toBe(T0 + 1000 + 15 * Min);
        expect(w.view.badge).toBe(1);
        expect(w.wakeAt).toBe(T0 + 1000 + 15 * Min);
    });

    it("brings no new visit during the delay, even for a new grave event, which only the badge counts", () => {
        const w = drive(AllCome);
        w.raise(High, T0);
        w.step({ type: "later", choice: "1h" }, T0 + 1000);
        w.raise(Critical, T0 + Min);
        w.raise(event("error", "agent:a"), T0 + 2 * Min);
        w.raise(event("blocked", "agent:b", T0 - Hour), T0 + 3 * Min);
        w.tick(T0 + 30 * Min);
        w.tick(T0 + Hour + 999);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(false);
        expect(w.view.badge).toBe(4);
    });

    it("brings one visit for everything when the delay ends", () => {
        const w = drive(AllCome);
        w.raise(High, T0);
        w.step({ type: "later", choice: "15min" }, T0 + 1000);
        w.raise(event("ci", "ci:/p:1"), T0 + Min);
        w.raise(Critical, T0 + 2 * Min);
        w.raise(event("ready", "ready:/p:2"), T0 + 3 * Min);
        w.tick(T0 + 1000 + 15 * Min - 1);
        expect(w.view.visit).toBeNull();
        w.tick(T0 + 1000 + 15 * Min);
        expect(w.view.visit).toEqual({
            severity: "grave",
            expression: "frown",
            keys: ["sec:critical", "sec:high", "ci:/p:1", "ready:/p:2"],
            count: 4,
        });
        expect(w.view.laterUntil).toBe(0);
    });

    it("brings no visit when everything was handled meanwhile", () => {
        const w = drive(AllCome);
        w.raise(Critical, T0);
        w.raise(event("error", "agent:a"), T0 + 1);
        w.step({ type: "later", choice: "5min" }, T0 + 2);
        w.step({ type: "cancel", key: "sec:critical" }, T0 + Min);
        w.step({ type: "cancel", key: "agent:a" }, T0 + 2 * Min);
        w.tick(T0 + 5 * Min + 2);
        expect(w.view.visit).toBeNull();
        expect(w.view.laterUntil).toBe(0);
    });

    it("comes only for what is left when part of it was handled meanwhile", () => {
        const w = drive(AllCome);
        w.raise(Critical, T0);
        w.raise(event("error", "agent:a"), T0 + 1);
        w.step({ type: "later", choice: "5min" }, T0 + 2);
        w.step({ type: "cancel", key: "sec:critical" }, T0 + Min);
        w.tick(T0 + 5 * Min + 2);
        expect(w.view.visit).toMatchObject({ severity: "important", keys: ["agent:a"] });
    });

    it("waits for the gate as well when the delay ends under the pointer, with the soft cue", () => {
        const w = drive();
        w.raise(High, T0);
        w.step({ type: "later", choice: "15min" }, T0 + 1);
        w.gate({ type: "enter" }, T0 + 15 * Min);
        w.tick(T0 + 1 + 15 * Min);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(true);
        w.gate({ type: "leave" }, T0 + 20 * Min);
        w.tick(T0 + 20 * Min + AfterLeaveMs);
        expect(w.view.visit).toMatchObject({ keys: ["sec:high"] });
    });

    describe("Escape takes the default delay of the severity", () => {
        const table: [string, BrokkEvent, number][] = [
            ["grave", Critical, 5 * Min],
            ["important", High, 15 * Min],
            ["neutre", event("ci", "ci:1"), Hour],
            ["bonne", event("ready", "ready:1"), Hour],
        ];

        it.each(table)("a %s visit: Escape", (_name, given, delay) => {
            const w = drive(AllCome);
            w.raise(given, T0);
            expect(w.view.visit).not.toBeNull();
            w.step({ type: "later", choice: "escape" }, T0 + 1000);
            expect(w.view.visit).toBeNull();
            expect(w.view.laterUntil).toBe(T0 + 1000 + delay);
        });
    });

    describe("each choice of each menu ends where it says", () => {
        const table: [string, BrokkEvent, SnoozeChoiceId, number][] = [
            ["grave", Critical, "5min", at(10, 5)],
            ["grave", Critical, "15min", at(10, 15)],
            ["grave", Critical, "1h", at(11)],
            ["important", High, "15min", at(10, 15)],
            ["important", High, "1h", at(11)],
            ["important", High, "tonight", at(18)],
            ["neutre", event("ci", "ci:1"), "1h", at(11)],
            ["neutre", event("ci", "ci:1"), "tonight", at(18)],
            ["neutre", event("ci", "ci:1"), "tomorrow", at(9, 0, 1)],
            ["bonne", event("ready", "ready:1"), "tomorrow", at(9, 0, 1)],
        ];

        it.each(table)("a %s visit: %s", (_name, given, choice, until) => {
            const w = drive(AllCome);
            w.raise(given, T0);
            w.step({ type: "later", choice }, T0);
            expect(w.view.laterUntil).toBe(until);
        });
    });

    it("takes the default delay for a choice its menu does not offer", () => {
        const w = drive();
        w.raise(Critical, T0);
        w.step({ type: "later", choice: "tomorrow" }, T0);
        expect(w.view.laterUntil).toBe(T0 + 5 * Min);
    });

    it("takes the default delay when this evening is asked too late for it", () => {
        const w = drive();
        w.raise(High, at(18, 30));
        w.step({ type: "later", choice: "tonight" }, at(18, 30));
        expect(w.view.laterUntil).toBe(at(18, 45));
    });

    it("is for the visit that is up: nothing happens when none is", () => {
        const w = drive();
        w.raise(event("ci", "ci:1"), T0);
        const before = w.model;
        expect(w.step({ type: "later", choice: "1h" }, T0 + 1).model).toBe(before);
        expect(w.view.laterUntil).toBe(0);
    });

    it("applies to the severity at the moment it is asked: a blocked agent that turned grave", () => {
        const w = drive();
        w.raise(event("blocked", "agent:a"), T0);
        w.tick(T0 + 5 * Min);
        w.tick(T0 + 15 * Min);
        w.step({ type: "later", choice: "escape" }, T0 + 16 * Min);
        expect(w.view.laterUntil).toBe(T0 + 21 * Min);
    });

    it("is not cancelled by Répondre: the panel opens, the delay stays", () => {
        const w = drive();
        w.raise(Critical, T0);
        w.step({ type: "later", choice: "1h" }, T0 + 1);
        w.step({ type: "open" }, T0 + 2);
        expect(w.view.laterUntil).toBe(T0 + 1 + Hour);
    });
});

describe("never under the pointer (FR-BOSS-009, AC8)", () => {
    it("waits while the pointer is over the sidebar, with the badge's soft cue", () => {
        const w = drive();
        w.gate({ type: "enter" }, T0);
        w.raise(High, T0 + 1);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(true);
        expect(w.view.mayArrive).toBe(false);
        w.tick(T0 + 10 * Min);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(true);
    });

    it("comes 1 s after the pointer left, and the cue goes with the visit", () => {
        const w = drive();
        w.gate({ type: "enter" }, T0);
        w.raise(High, T0 + 1);
        w.gate({ type: "leave" }, T0 + 1000);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(true);
        expect(w.wakeAt).toBe(T0 + 1000 + AfterLeaveMs);
        w.tick(T0 + 1000 + AfterLeaveMs - 1);
        expect(w.view.visit).toBeNull();
        w.tick(T0 + 1000 + AfterLeaveMs);
        expect(w.view.visit).toMatchObject({ keys: ["sec:high"] });
        expect(w.view.cue).toBe(false);
    });

    it("waits 2 s after a gesture in the sidebar", () => {
        const w = drive();
        w.gate({ type: "act" }, T0);
        w.raise(High, T0 + 1);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(true);
        expect(w.wakeAt).toBe(T0 + AfterActionMs);
        w.tick(T0 + AfterActionMs - 1);
        expect(w.view.visit).toBeNull();
        w.tick(T0 + AfterActionMs);
        expect(w.view.visit).not.toBeNull();
    });

    it("waits for the search field, a menu, a dialog and a drag, for as long as they last", () => {
        // How long after being released the gate still holds: a menu closing ends nothing but itself.
        const cases: [GateEvent, GateEvent, number][] = [
            [{ type: "search", focused: true }, { type: "search", focused: false }, AfterActionMs],
            [{ type: "overlay", open: true }, { type: "overlay", open: false }, 0],
            [{ type: "dragstart" }, { type: "dragend" }, AfterActionMs],
        ];
        for (const [hold, release, settle] of cases) {
            const w = drive();
            w.gate(hold, T0);
            w.raise(High, T0 + 1);
            w.tick(T0 + 30 * Min);
            expect(w.view.visit, hold.type).toBeNull();
            expect(w.view.cue, hold.type).toBe(true);
            expect(w.wakeAt, hold.type).toBeNull();
            w.gate(release, T0 + 31 * Min);
            if (settle > 0) {
                expect(w.view.visit, hold.type).toBeNull();
                expect(w.wakeAt, hold.type).toBe(T0 + 31 * Min + settle);
            }
            w.tick(T0 + 31 * Min + settle);
            expect(w.view.visit, hold.type).not.toBeNull();
        }
    });

    it("does not take the scene back when the pointer comes in while he is there", () => {
        const w = drive();
        w.raise(High, T0);
        w.gate({ type: "enter" }, T0 + 1);
        w.gate({ type: "act" }, T0 + 2);
        expect(w.view.visit).not.toBeNull();
        expect(w.view.cue).toBe(false);
    });

    it("exposes whether he may arrive now, for any surface", () => {
        const w = drive();
        expect(w.view.mayArrive).toBe(true);
        w.gate({ type: "enter" }, T0);
        expect(w.view.mayArrive).toBe(false);
        w.gate({ type: "leave" }, T0 + 1);
        expect(w.view.mayArrive).toBe(false);
        w.tick(T0 + 1 + AfterLeaveMs);
        expect(w.view.mayArrive).toBe(true);
    });

    it("shows no cue when nothing waits, whatever the gate does", () => {
        const w = drive();
        w.gate({ type: "enter" }, T0);
        expect(w.view.cue).toBe(false);
        w.raise(event("ci", "ci:1"), T0 + 1);
        expect(w.view.cue).toBe(false);
    });

    it("shows no cue during Plus tard: he is not waiting, he was sent away", () => {
        const w = drive();
        w.raise(High, T0);
        w.step({ type: "later", choice: "1h" }, T0 + 1);
        w.gate({ type: "enter" }, T0 + 2);
        w.raise(Critical, T0 + 3);
        expect(w.view.cue).toBe(false);
    });
});

describe("what moves the collapsed sidebar (#2155)", () => {
    it("lists only the events set to Vient: Badge counts, Rien neither counts nor moves", () => {
        const w = drive({
            ...DefaultVisitSettings,
            coming: { ...DefaultVisitSettings.coming, error: "badge", ci: "rien", security: "vient" },
        });
        w.raise(High, T0);
        w.raise(event("error", "agent:x"), T0);
        w.raise(event("ci", "ci:/p:1"), T0);
        expect(w.view.badgeKeys).toEqual(["agent:x", "sec:high"]);
        expect(w.view.comingKeys).toEqual(["sec:high"]);
    });

    it("lists none while he never comes", () => {
        const w = drive({ ...DefaultVisitSettings, never: true });
        w.raise(High, T0);
        expect(w.view.badgeKeys).toEqual(["sec:high"]);
        expect(w.view.comingKeys).toEqual([]);
    });
});

describe("quiet hours and the master switch (FR-BOSS-009, AC4)", () => {
    it("holds his visit during quiet hours, counts on the badge, and brings him when they end", () => {
        const w = drive();
        w.tick(at(21));
        w.raise(High, at(22, 30));
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(false);
        expect(w.view.mayArrive).toBe(false);
        expect(w.view.badge).toBe(1);
        expect(w.wakeAt).toBe(at(8, 0, 1));
        w.tick(at(7, 59, 1));
        expect(w.view.visit).toBeNull();
        w.tick(at(8, 0, 1));
        expect(w.view.visit).toMatchObject({ keys: ["sec:high"] });
    });

    it("does not come at 22:00 for an event raised just before, and does after the quiet hours", () => {
        const w = drive();
        w.tick(at(21, 50));
        w.gate({ type: "enter" }, at(21, 50));
        w.raise(High, at(21, 55));
        w.gate({ type: "leave" }, at(21, 59));
        w.tick(at(22, 0) + 1);
        expect(w.view.visit).toBeNull();
        w.tick(at(8, 0, 1));
        expect(w.view.visit).not.toBeNull();
    });

    it("does not take back the scene that is up when the quiet hours begin", () => {
        const w = drive();
        w.tick(at(21, 59));
        w.raise(High, at(21, 59));
        expect(w.view.visit).not.toBeNull();
        w.tick(at(22, 1));
        expect(w.view.visit).not.toBeNull();
    });

    it("ignores the quiet hours when they are turned off", () => {
        const w = drive({ ...DefaultVisitSettings, quiet: { ...DefaultVisitSettings.quiet, on: false } });
        w.tick(at(23));
        w.raise(High, at(23, 30));
        expect(w.view.visit).not.toBeNull();
    });

    it("follows the hours of the setting, within a day as well as across midnight", () => {
        const w = drive({ ...DefaultVisitSettings, quiet: { on: true, from: 13 * 60, to: 14 * 60 } });
        w.tick(at(12, 59));
        w.raise(High, at(13, 10));
        expect(w.view.visit).toBeNull();
        expect(w.wakeAt).toBe(at(14));
        w.tick(at(14));
        expect(w.view.visit).not.toBeNull();
    });

    it("never comes with the master switch, and counts all the same", () => {
        const w = drive({ ...DefaultVisitSettings, never: true });
        w.raise(Critical, T0);
        w.raise(event("blocked", "agent:a", T0 - Hour), T0 + 1);
        expect(w.view.visit).toBeNull();
        expect(w.view.cue).toBe(false);
        expect(w.view.badge).toBe(2);
        w.tick(T0 + 24 * Hour);
        expect(w.view.visit).toBeNull();
    });

    it("takes back the scene that is up when the master switch is turned on, and brings him back when it is off", () => {
        const w = drive();
        w.raise(Critical, T0);
        expect(w.view.visit).not.toBeNull();
        w.step({ type: "settings", settings: { ...DefaultVisitSettings, never: true } }, T0 + 1);
        expect(w.view.visit).toBeNull();
        expect(w.view.badge).toBe(1);
        w.step({ type: "settings", settings: DefaultVisitSettings }, T0 + 2);
        expect(w.view.visit).toMatchObject({ keys: ["sec:critical"] });
    });
});

describe("when to be called again", () => {
    it("names nothing when nothing waits", () => {
        const w = drive();
        expect(w.wakeAt).toBeNull();
        w.raise(event("ci", "ci:1"), T0);
        expect(w.wakeAt).toBeNull();
    });

    it("names the earliest moment of what changes by itself", () => {
        const w = drive();
        w.raise(event("blocked", "agent:a", T0), T0);
        expect(w.wakeAt).toBe(T0 + 5 * Min);
        w.raise(event("blocked", "agent:b", T0 - 2 * Min), T0 + 1);
        expect(w.wakeAt).toBe(T0 + 3 * Min);
    });

    it("never names a moment that is not in the future", () => {
        const w = drive();
        w.raise(event("blocked", "agent:a", T0 - 20 * Min), T0);
        expect(w.wakeAt).toBeNull();
        w.step({ type: "later", choice: "1h" }, T0 + 1);
        expect(w.wakeAt).toBe(T0 + 1 + Hour);
        w.tick(T0 + 1 + Hour);
        expect(w.wakeAt).toBeNull();
    });
});

describe("fed by any source (FR-BOSS-009, AC11)", () => {
    it("takes the bell, the downloads, the update and the usage the way it takes the rows", () => {
        const w = drive(AllCome);
        w.gate({ type: "enter" }, T0);
        w.raise(event("downloadfailed", "download:1"), T0 + 1, "downloads");
        w.raise(event("update", "update:1.0.1"), T0 + 2, "updates");
        w.raise(event("usage", "usage:claude"), T0 + 3, "usage");
        w.step({ type: "sync", source: "bell", events: [event("finished", "finished:b1")] }, T0 + 4);
        expect(w.view.badge).toBe(4);
        w.gate({ type: "leave" }, T0 + 5);
        w.tick(T0 + 5 + AfterLeaveMs);
        expect(w.view.visit).toMatchObject({ severity: "neutre", expression: "call", count: 4 });
        w.step({ type: "cancel", key: "download:1" }, T0 + 3000);
        w.step({ type: "cancel", key: "update:1.0.1" }, T0 + 3001);
        w.step({ type: "cancel", key: "usage:claude" }, T0 + 3002);
        expect(w.view.visit).toMatchObject({ severity: "bonne", expression: "smile", count: 1 });
    });

    it("keeps the model free of any surface: a plain value goes in, a plain value comes out", () => {
        const w = drive();
        w.raise(High, T0);
        expect(JSON.parse(JSON.stringify(w.model))).toEqual(w.model);
        expect(JSON.parse(JSON.stringify(w.view))).toEqual(w.view);
    });
});
