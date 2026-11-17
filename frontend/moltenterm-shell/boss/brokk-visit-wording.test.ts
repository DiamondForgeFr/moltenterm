// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How a visit varies its words (FR-BOSS-009, AC82, #2222). A seeded random source and the shipped dictionaries: nothing
// here waits.

import { describe, expect, it } from "vitest";
import { flattenKeys, interpolate, resolveKey, shippedDictionary } from "../i18n/i18n-core";
import {
    decodeWording,
    drawWording,
    encodeWording,
    rememberWording,
    VisitPhrasings,
    VisitReason,
    VisitReasons,
    windowOf,
    wordingKey,
} from "./brokk-visit-wording";

// A small deterministic random source (mulberry32): the same seed draws the same numbers on any machine.
function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("the window of phrasings he does not say again (FR-BOSS-009, AC82)", () => {
    it("is half the set, rounded up, which leaves at least two to draw from", () => {
        expect([4, 5, 6].map(windowOf)).toEqual([2, 3, 3]);
        for (const size of [4, 5, 6]) {
            expect(size - windowOf(size)).toBeGreaterThanOrEqual(2);
        }
    });

    it("never draws one of the last phrasings said, whatever the random source gives", () => {
        for (const size of [4, 5, 6]) {
            for (let seed = 1; seed <= 40; seed++) {
                const random = seeded(seed);
                let recent: number[] = [];
                for (let visit = 0; visit < 60; visit++) {
                    const index = drawWording(size, recent, random);
                    expect(index, `size ${size}, seed ${seed}, visit ${visit}`).toBeGreaterThanOrEqual(0);
                    expect(index).toBeLessThan(size);
                    expect(recent.slice(-windowOf(size)), `size ${size}, seed ${seed}, visit ${visit}`).not.toContain(
                        index
                    );
                    recent = rememberWording(recent, index, size);
                }
            }
        }
    });

    it("holds at the extremes of the random source", () => {
        for (const extreme of [0, 0.999999999, 1]) {
            let recent: number[] = [];
            for (let visit = 0; visit < 20; visit++) {
                const index = drawWording(5, recent, () => extreme);
                expect(recent.slice(-windowOf(5))).not.toContain(index);
                recent = rememberWording(recent, index, 5);
            }
        }
    });

    it("uses every phrasing of the set over time", () => {
        for (const size of [4, 5, 6]) {
            const random = seeded(7);
            const used = new Set<number>();
            let recent: number[] = [];
            for (let visit = 0; visit < 80; visit++) {
                const index = drawWording(size, recent, random);
                used.add(index);
                recent = rememberWording(recent, index, size);
            }
            expect(used.size, `size ${size}`).toBe(size);
        }
    });

    it("keeps no more than the window, the oldest first, with no phrasing twice", () => {
        let recent: number[] = [];
        for (const index of [0, 1, 2, 3, 1, 4]) {
            recent = rememberWording(recent, index, 5);
        }
        expect(recent).toEqual([3, 1, 4]);
    });

    it("draws again from the whole set when what was kept is nonsense, rather than nothing", () => {
        expect(drawWording(4, [0, 1, 2, 3], () => 0)).toBe(0);
        expect(drawWording(1, [], () => 0.7)).toBe(0);
        expect(drawWording(0, [], () => 0.7)).toBe(0);
    });
});

describe("what was said, kept across restarts (FR-BOSS-009, AC82)", () => {
    it("is saved and read back as it was", () => {
        const memory = { ciFailed: [1, 3], ready: [0] };
        expect(decodeWording(encodeWording(memory))).toEqual(memory);
    });

    it("is read as nothing said when it is not usable, and keeps only what fits a set", () => {
        for (const text of ["", "not json", "null", "[]", "7", '"x"']) {
            expect(decodeWording(text), text).toEqual({});
        }
        expect(decodeWording('{"ciFailed":[1,"x",-1,9,2.5,3],"nope":[1],"ready":"1","download":[0,1,2,3]}')).toEqual({
            ciFailed: [1, 3],
            download: [2, 3],
        });
    });
});

describe("the phrasings of every reason, in both languages (FR-BOSS-009, AC78, AC82, #2222)", () => {
    const Placeholders: Record<VisitReason, string[]> = {
        waitedFor: ["minutes", "name"],
        waiting: ["name"],
        asks: ["name"],
        goAhead: ["name"],
        error: ["name"],
        ciFailed: ["number"],
        ready: ["number"],
        download: [],
        update: [],
        usage: [],
        security: [],
        other: [],
    };
    // The collapsed sidebar says the line in two lines of about 28 characters (brokk-visit-scene.css): a sentence that is
    // longer than this, with the longest name, number and duration, is cut short by an ellipsis.
    const MaxSentenceChars = 64;
    const Longest = { name: "Bérénice", minutes: 125, number: 2204 };

    function phrasings(code: string, reason: VisitReason): string[] {
        const dict = shippedDictionary(code);
        return Array.from({ length: VisitPhrasings[reason] }, (_, i) => resolveKey(dict, wordingKey(reason, i)));
    }

    function placeholdersOf(text: string): string[] {
        return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    }

    it("have four to six phrasings each, as many as the table says", () => {
        for (const reason of VisitReasons) {
            expect(VisitPhrasings[reason], reason).toBeGreaterThanOrEqual(4);
            expect(VisitPhrasings[reason], reason).toBeLessThanOrEqual(6);
        }
        expect(VisitReasons).toHaveLength(12);
    });

    it("exist in en.json and fr.json, with no more in either, and no other reason", () => {
        const expected = VisitReasons.flatMap((reason) =>
            Array.from({ length: VisitPhrasings[reason] }, (_, i) => wordingKey(reason, i))
        );
        for (const code of ["en", "fr"]) {
            const dict = shippedDictionary(code);
            for (const key of expected) {
                expect(resolveKey(dict, key), `${code} ${key}`).toMatch(/\S/);
            }
            const present = flattenKeys(dict).filter((key) => key.startsWith("boss.visit.reason."));
            expect(present.sort(), code).toEqual([...expected].sort());
        }
    });

    it("carry the placeholders of their reason, the same in both languages", () => {
        for (const reason of VisitReasons) {
            for (const code of ["en", "fr"]) {
                phrasings(code, reason).forEach((text, i) => {
                    expect(placeholdersOf(text), `${code} ${wordingKey(reason, i)}`).toEqual(Placeholders[reason]);
                });
            }
        }
    });

    it("are all different in their set, and open on different words: not one sentence said five ways", () => {
        for (const code of ["en", "fr"]) {
            for (const reason of VisitReasons) {
                const texts = phrasings(code, reason);
                expect(new Set(texts).size, `${code} ${reason}`).toBe(texts.length);
                const openings = texts.map((text) => text.split(/\s+/).slice(0, 5).join(" ").toLowerCase());
                expect(new Set(openings).size, `${code} ${reason}`).toBe(texts.length);
            }
        }
    });

    it("are one short sentence or two, which the half-open sidebar can say in its two lines", () => {
        for (const code of ["en", "fr"]) {
            for (const reason of VisitReasons) {
                phrasings(code, reason).forEach((text, i) => {
                    const key = `${code} ${wordingKey(reason, i)}`;
                    const shown = interpolate(text, Longest, code);
                    expect(shown, key).not.toMatch(/\n/);
                    expect(shown.length, key).toBeLessThanOrEqual(MaxSentenceChars);
                    expect(shown, key).toMatch(/[.?!]$/);
                });
            }
        }
    });

    it("restate no notification: no title, no check, no message, no ticket, no file, no link", () => {
        const echoes = /notification|title|titre|check name|nom du contr|ticket|\.go\b|\.ts\b|https?:|www\.|«|»|["“”]/i;
        for (const code of ["en", "fr"]) {
            for (const reason of VisitReasons) {
                phrasings(code, reason).forEach((text, i) => {
                    expect(text, `${code} ${wordingKey(reason, i)}`).not.toMatch(echoes);
                });
            }
        }
    });

    it("name no machine and no OS", () => {
        const names = /\b(mac|macos|windows|linux|finder|explorer|computer|ordinateur|machine)\b/i;
        for (const code of ["en", "fr"]) {
            for (const reason of VisitReasons) {
                phrasings(code, reason).forEach((text, i) => {
                    expect(text, `${code} ${wordingKey(reason, i)}`).not.toMatch(names);
                });
            }
        }
    });

    it("say vous in French, never tu, and give the developer no gender", () => {
        const tu = /\b(tu|toi|ton|ta|tes|te|t')\b|\bt'/i;
        const gendered =
            /\b(prêt|prête|prêts|prêtes|content|contente|fatigué|fatiguée|désolé|désolée|occupé|occupée|pressé|pressée|seul|seule|invité|invitée|bienvenu|bienvenue|sûr|sûre|ravi|ravie|surpris|surprise)\b|\(e\)|·e\b/i;
        const dict = shippedDictionary("fr");
        for (const reason of VisitReasons) {
            phrasings("fr", reason).forEach((text, i) => {
                const key = wordingKey(reason, i);
                expect(text, key).not.toMatch(tu);
                expect(text, key).not.toMatch(gendered);
            });
        }
        expect(resolveKey(dict, "boss.visit.more.one")).not.toMatch(gendered);
        expect(resolveKey(dict, "boss.visit.more.other")).not.toMatch(gendered);
    });

    it("give the other events of a visit a sentence of their own, with a singular and a plural", () => {
        for (const code of ["en", "fr"]) {
            const dict = shippedDictionary(code);
            const one = resolveKey(dict, "boss.visit.more.one");
            const other = resolveKey(dict, "boss.visit.more.other");
            expect(one, code).toMatch(/\S/);
            expect(one, code).not.toContain("{count}");
            expect(placeholdersOf(other), code).toEqual(["count"]);
            for (const text of [one, other]) {
                expect(text, code).toMatch(/[.?!]$/);
                expect(text, code).not.toMatch(/^(and|et)\b/i);
            }
        }
    });

    it("no longer keep the wait's one wording, which the visit alone used", () => {
        for (const code of ["en", "fr"]) {
            expect(resolveKey(shippedDictionary(code), "boss.screen.waitedFor"), code).toBeUndefined();
        }
    });
});
