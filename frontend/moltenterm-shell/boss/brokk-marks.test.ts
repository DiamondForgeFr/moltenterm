// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { finishedAfterHeard } from "./brokk-hub-feed";
import {
    clearParked,
    EmptyParked,
    moodText,
    parkedKeysOf,
    parkedText,
    parkRow,
    readHeard,
    readMood,
    readParked,
} from "./brokk-marks";
import { EmptyMood } from "./brokk-mood";

describe("Brokk's shared marks (FR-BOSS-009, AC106, #2391)", () => {
    it("keeps a row set aside until the next opening, wherever either happened", () => {
        let parked = parkRow(EmptyParked, "agent:a", 100);
        parked = parkRow(readParked(parkedText(parked)), "ci:/p:1", 110);
        expect(parkedKeysOf(parked)).toEqual({ "agent:a": true, "ci:/p:1": true });
        const opened = clearParked(parked, 200);
        expect(parkedKeysOf(readParked(parkedText(opened)))).toEqual({});
        // A Later written at the very moment of the opening is after it.
        expect(parkedKeysOf(parkRow(opened, "agent:b", 200))).toEqual({ "agent:b": true });
    });

    it("reads anything odd as nothing", () => {
        expect(readParked("{")).toEqual(EmptyParked);
        expect(readParked(42)).toEqual(EmptyParked);
        expect(readParked(JSON.stringify({ clearedAt: 50, keys: { old: 40, fresh: 60 } })).keys).toEqual({ fresh: 60 });
        expect(readHeard("12")).toBe(0);
        expect(readHeard(-1)).toBe(0);
        expect(readHeard(1234)).toBe(1234);
        expect(readMood("nope")).toBeNull();
        expect(readMood(JSON.stringify({ at: 5, memory: {} }))).toBeNull();
        expect(readMood(moodText({ at: 5, memory: EmptyMood }))).toEqual({ at: 5, memory: EmptyMood });
    });

    it("counts as finished every done agent whose finish is after the last opening", () => {
        const data = {
            states: {
                a: { blockid: "a", state: "done" as const, since: 300, version: 1 },
                b: { blockid: "b", state: "done" as const, since: 100, version: 1 },
                c: { blockid: "c", state: "working" as const, since: 400, version: 1 },
                d: { blockid: "d", state: "done" as const, version: 1 },
            },
            versions: {},
        };
        expect(finishedAfterHeard(data, [], 200).map((e) => e.key)).toEqual(["finished:a"]);
        // An agent whose state gives no moment counts when this page saw it finish.
        const seen = [{ key: "finished:d", kind: "finished" as const, since: 250 }];
        expect(finishedAfterHeard(data, seen, 200).map((e) => e.key)).toEqual(["finished:a", "finished:d"]);
    });
});
