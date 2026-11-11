// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGraphBlock } from "../brainstorm/brainstorm-graph-model";
import { parseReply, withAnswer } from "./brokk-exchange-model";
import { BrokkTones, readTone, ToneGesture, toneOf } from "./brokk-tone";
import Manifest from "./portrait/brokk/brokk-manifest.json";

// FR-BOSS-009, AC88 (#2259): synthetic answers only.
describe("the tone of his answer (AC88)", () => {
    it("reads the marker his answer opens with, and never shows it", () => {
        expect(readTone("[[smile]]\nFine, thanks. The forge is warm.")).toEqual({
            text: "Fine, thanks. The forge is warm.",
            tone: "smile",
        });
        expect(readTone("[[concerned]] The checks of PR 12 came back red.")).toEqual({
            text: "The checks of PR 12 came back red.",
            tone: "concerned",
        });
    });

    it("reads any case and spaces in the marker, as the suite's contract does", () => {
        expect(readTone("[[ Amused ]] Ha.").tone).toBe("amused");
    });

    it("is neutral without a marker, and never guesses from his words", () => {
        expect(readTone("Great news, I am so happy!")).toEqual({ text: "Great news, I am so happy!", tone: "neutral" });
        expect(readTone("").tone).toBe("neutral");
        expect(readTone(null)).toEqual({ text: "", tone: "neutral" });
    });

    it("is neutral for a name outside the list, which is taken out all the same", () => {
        expect(readTone("[[furious]] Hm.")).toEqual({ text: "Hm.", tone: "neutral" });
        expect(toneOf("ecstatic")).toBe("neutral");
    });

    it("takes the first marker for the tone and leaves out every marker", () => {
        expect(readTone("[[warm]] Thanks. [[proud]] Nice work.")).toEqual({ text: "Thanks. Nice work.", tone: "warm" });
    });

    it("holds back a marker cut at the end while his answer is still being written", () => {
        expect(readTone("[[smi", false)).toEqual({ text: "", tone: "neutral" });
        expect(readTone("[[smile]]\nFine", false)).toEqual({ text: "Fine", tone: "smile" });
        expect(readTone("Fine. [[", false).text).not.toContain("[");
    });

    it("leaves a marker in a block of code as written", () => {
        const answer = '[[smile]] Here it is:\n\n```toml\n[[bin]]\nname = "forge"\n```\n\nThat is all.';
        const read = readTone(answer);
        expect(read.tone).toBe("smile");
        expect(read.text).toBe('Here it is:\n\n```toml\n[[bin]]\nname = "forge"\n```\n\nThat is all.');
    });

    it("keeps a team's own [[page link]] of several words", () => {
        expect(readTone("See [[Release notes]].").text).toBe("See [[Release notes]].");
    });
});

describe("the tone in his exchange (AC88)", () => {
    it("is read with his words and the replies, the marker in neither", () => {
        const parsed = parseReply('[[smile]]\nFine, thanks.\n\n```brokk-actions\n["Good"]\n```');
        expect(parsed).toEqual({ text: "Fine, thanks.", actions: [{ label: "Good", authorise: true }], tone: "smile" });
    });

    it("is kept on his item, and a half-written marker never shows while he writes", () => {
        const first = withAnswer([], "m1", { markdown: "[[sur", turn: 1, at: 1, final: false });
        expect(first[0]).toMatchObject({ text: "", tone: "neutral" });
        const next = withAnswer(first, "m1", { markdown: "[[surprised]] Oh!", turn: 1, at: 2, final: false });
        expect(next[0]).toMatchObject({ text: "Oh!", tone: "surprised" });
    });

    it("never shows in the brainstorm's words either", () => {
        const read = readGraphBlock(
            '[[thinking]] Let us see.\n\n```brokk-graph\n{"v":1,"talk":"project","ops":[]}\n```'
        );
        expect(read.text).toBe("Let us see.");
    });
});

describe("the tones and his clips (AC88)", () => {
    const gestures = new Set(Manifest.idles.listening.map((idle) => idle.name));

    it("plays only clips he ships", () => {
        for (const tone of BrokkTones) {
            const gesture = ToneGesture[tone];
            if (gesture != null) {
                expect(gestures.has(gesture), `${tone} → ${gesture}`).toBe(true);
                expect(Manifest.expressionMs).toHaveProperty(gesture);
            }
        }
    });

    it("maps the tones the ticket names: a smile for smile, warm and amused, a frown for concerned, a doubt for thinking", () => {
        expect(ToneGesture).toEqual({
            smile: "smile",
            warm: "smile",
            amused: "smile",
            proud: null,
            concerned: "frown",
            surprised: null,
            thinking: "doubtful",
            neutral: null,
        });
    });

    it("lists for Constance only proud and surprised: the tones no clip of his carries", () => {
        const missing = BrokkTones.filter((tone) => tone !== "neutral" && ToneGesture[tone] == null);
        expect(missing).toEqual(["proud", "surprised"]);
    });

    it("is the list his brief teaches", () => {
        const brief = readFileSync(join(__dirname, "../../../pkg/molten/brokksession/brief.md"), "utf8");
        const section = brief.slice(brief.indexOf("## Your tone"));
        const taught = [...section.matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
        expect(taught).toEqual([...BrokkTones]);
        expect(section).toContain("\n[[smile]]\n");
    });
});
