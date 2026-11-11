// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnswerWaitLimitMs, ExpressionMs } from "./brokk-queue";
import {
    alreadySaid,
    AskedFadeMs,
    MinSpeakingMs,
    NoSpeech,
    PoseClipMs,
    RevealCapMs,
    RevealCharsPerSecond,
    revealingAt,
    revealMs,
    shownAt,
    speakingAt,
    SpeakingSettleMs,
    speakingUntil,
    Speech,
    speechAfterHeard,
    speechFlushed,
    speechWakeAt,
    StartTrack,
    talkFace,
    ThinkingDelayMs,
    toneDelayMs,
    TonePromptMs,
    trackAfter,
} from "./brokk-speech-model";
import { brokkPose } from "./brokk-state-model";
import { BrokkTones, ToneGesture } from "./brokk-tone";
import Manifest from "./portrait/brokk/brokk-manifest.json";

// Synthetic text only (FR-BOSS-009, AC86 to AC88, #2259).
const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i % 10}`).join(" ");

function heard(speech: Speech, text: string, now: number, tone: any = "neutral", instant = false) {
    return speechAfterHeard(speech, { id: "m1", text, tone }, now, instant);
}

describe("his words are revealed as he says them (AC87)", () => {
    it("runs at about three times an average reading speed", () => {
        // An average reader takes some 23 characters a second.
        expect(RevealCharsPerSecond).toBeGreaterThanOrEqual(3 * 20);
        expect(RevealCharsPerSecond).toBeLessThanOrEqual(3 * 26);
        const text = "Fine, thanks. The forge is warm and two agents are at work.";
        const { speech } = heard(NoSpeech, text, 0);
        expect(speech.endAt).toBeCloseTo((text.length * 1000) / RevealCharsPerSecond);
        expect(shownAt(speech, 0)).toBe(0);
        expect(shownAt(speech, speech.endAt)).toBe(text.length);
    });

    it("shows a 1,500-character answer whole within the cap", () => {
        const text = words(251).slice(0, 1500);
        expect(text.length).toBe(1500);
        const { speech } = heard(NoSpeech, text, 1000);
        expect(speech.endAt - 1000).toBe(RevealCapMs);
        expect(RevealCapMs).toBeLessThanOrEqual(5000);
        expect(shownAt(speech, 1000 + RevealCapMs)).toBe(1500);
        expect(revealingAt(speech, 1000 + RevealCapMs)).toBe(false);
        expect(revealMs(1_000_000)).toBe(RevealCapMs);
    });

    it("shows whole words only", () => {
        const text = "Fine thanks forge";
        const { speech } = heard(NoSpeech, text, 0);
        for (let t = 0; t <= speech.endAt; t += 10) {
            const shown = text.slice(0, shownAt(speech, t));
            expect(["", "Fine", "Fine thanks", text]).toContain(shown);
        }
    });

    it("goes on from what shows when more of the answer is read, within the cap again", () => {
        const first = heard(NoSpeech, "First part.", 0).speech;
        const mid = 80;
        const shownMid = shownAt(first, mid);
        const second = heard(first, `First part. ${words(300)}`, mid).speech;
        expect(second.from).toBe(shownMid);
        expect(second.endAt).toBe(mid + RevealCapMs);
        expect(second.saidAt).toBe(0);
    });

    it("starts over for a new answer", () => {
        const first = heard(NoSpeech, "First.", 0).speech;
        const next = speechAfterHeard(first, { id: "m2", text: "Second.", tone: "neutral" }, 5000, false).speech;
        expect(next).toMatchObject({ id: "m2", from: 0, saidAt: 5000 });
    });

    it("shows the rest at once on a click or a key", () => {
        const { speech } = heard(NoSpeech, words(100), 0);
        expect(revealingAt(speech, 100)).toBe(true);
        const flushed = speechFlushed(speech, 100);
        expect(shownAt(flushed, 100)).toBe(flushed.text.length);
        expect(revealingAt(flushed, 100)).toBe(false);
        expect(speechFlushed(flushed, 200)).toBe(flushed);
    });

    it("shows it at once with reduced motion", () => {
        const { speech } = heard(NoSpeech, words(100), 0, "neutral", true);
        expect(shownAt(speech, 0)).toBe(speech.text.length);
        expect(revealingAt(speech, 0)).toBe(false);
    });

    it("never reveals again what was there before the window listened", () => {
        const said = alreadySaid({ id: "m1", text: "Old answer." });
        expect(revealingAt(said, 0)).toBe(false);
        expect(speakingAt(said, 0)).toBe(false);
        expect(heard(said, "Old answer.", 10).speech).toBe(said);
        expect(heard(said, "Old answer. And more.", 10).speech.from).toBe("Old answer.".length);
    });

    it("waits for words: an answer read empty starts nothing", () => {
        const step = heard(NoSpeech, "", 0, "smile");
        expect(step.gesture).toBeNull();
        expect(speakingAt(step.speech, 0)).toBe(false);
    });

    it("asks to be looked at while words are revealed, then when his speech ends", () => {
        const { speech } = heard(NoSpeech, words(20), 0);
        expect(speechWakeAt(speech, 0)).toBeGreaterThan(0);
        expect(speechWakeAt(speech, speech.endAt)).toBe(speakingUntil(speech));
        expect(speechWakeAt(speech, speakingUntil(speech))).toBeNull();
    });
});

describe("his face speaks while his words come (AC87)", () => {
    it("speaks from the first word until the reveal ends and a short settle", () => {
        const { speech } = heard(NoSpeech, words(60), 0);
        expect(speakingAt(speech, 0)).toBe(true);
        expect(speakingUntil(speech)).toBe(speech.endAt + SpeakingSettleMs);
        expect(speakingAt(speech, speech.endAt + SpeakingSettleMs - 1)).toBe(true);
        expect(speakingAt(speech, speech.endAt + SpeakingSettleMs)).toBe(false);
    });

    it("speaks long enough to read as speech for a short answer", () => {
        const { speech } = heard(NoSpeech, "Yes.", 0);
        expect(speakingUntil(speech)).toBe(MinSpeakingMs);
    });

    it("settles soon after a click shows the rest", () => {
        const { speech } = heard(NoSpeech, words(250), 0);
        const flushed = speechFlushed(speech, 500);
        expect(speakingUntil(flushed)).toBe(Math.max(500 + SpeakingSettleMs, MinSpeakingMs));
    });
});

describe("the tone plays first, then he speaks (AC88)", () => {
    it("asks his smile once, with his first words", () => {
        const first = heard(NoSpeech, "Fine,", 0, "smile");
        expect(first.gesture).toBe("smile");
        const more = heard(first.speech, "Fine, thanks.", 1500, "smile");
        expect(more.gesture).toBeNull();
    });

    it("keeps him speaking past the gesture", () => {
        const { speech } = heard(NoSpeech, "Fine, thanks.", 0, "smile");
        expect(speakingUntil(speech)).toBe(AskedFadeMs + ExpressionMs.smile + SpeakingSettleMs);
    });

    it("asks nothing for neutral, for a tone he has no clip for, or without a tone", () => {
        expect(heard(NoSpeech, "Fine.", 0, "neutral").gesture).toBeNull();
        expect(heard(NoSpeech, "Fine.", 0, "proud").gesture).toBeNull();
        expect(heard(NoSpeech, "Fine.", 0, undefined).gesture).toBeNull();
        expect(speakingUntil(heard(NoSpeech, "Fine.", 0, "proud").speech)).toBe(MinSpeakingMs);
    });

    it("plays the gesture in the listening pose, then speaks", () => {
        const situation = { working: 0, waiting: 0, cardOpen: true, talk: "answering" as const };
        expect(brokkPose(situation, { speaking: false, expression: "smile" })).toBe("listening");
        expect(brokkPose(situation, { speaking: false, expression: null })).toBe("speaking");
    });
});

// The length of a clip from its WebM header (the Segment's Duration, in TimecodeScale units of 1 ms by default): the
// timing data of the clips the manifest names, read without playing them.
function clipMs(name: string): number {
    const data = readFileSync(join(__dirname, "portrait", "brokk", `${name}.webm`));
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] !== 0x44 || data[i + 1] !== 0x89) {
            continue;
        }
        if (data[i + 2] === 0x88) {
            return data.readDoubleBE(i + 3);
        }
        if (data[i + 2] === 0x84) {
            return data.readFloatBE(i + 3);
        }
    }
    throw new Error(`${name}.webm has no duration`);
}

describe("the tone starts with his first words (AC88, #2259)", () => {
    const frameMs = 1000 / Manifest.fps;

    it("is a gesture of the listening loop, which the package plays at once over a short crossfade", () => {
        const listening = Manifest.idles.listening;
        for (const tone of BrokkTones) {
            const gesture = ToneGesture[tone];
            if (gesture == null) {
                continue;
            }
            expect(listening.find((idle) => idle.name === gesture)).toMatchObject({ onDemand: true });
        }
        // The listening and speaking loops swap with no clip between them.
        expect(Manifest.transitions).not.toContain("speaking>listening");
        expect(Manifest.transitions).not.toContain("listening>speaking");
        expect(Manifest.samePose).toEqual(["listening>speaking", "speaking>listening"]);
        expect(AskedFadeMs).toBeLessThanOrEqual(TonePromptMs);
        expect(TonePromptMs).toBeLessThanOrEqual(500);
        expect(AnswerWaitLimitMs).toBeLessThanOrEqual(TonePromptMs);
    });

    it("starts within the prompt delay on a face that listened or spoke, whatever frame its loop is at", () => {
        const listening = trackAfter(StartTrack, "typing", 0);
        expect(toneDelayMs(listening, 1000)).toBe(AskedFadeMs);
        const step = speechAfterHeard(NoSpeech, { id: "m1", text: "Fine,", tone: "smile" }, 1000, false, listening);
        expect(step.gesture).toBe("smile");
        // The loop is 72 frames: the crossfade covers less than a tenth of it.
        expect(AskedFadeMs / frameMs).toBeLessThan(72 / 10);
    });

    it("measures the clips between poses at PoseClipMs: 48 frames at the manifest's frame rate", () => {
        // His group never rests (the card is open): its clips are those to and from thinking.
        const group = Manifest.transitions.filter((t) => t.includes("thinking") && !t.includes("rest"));
        expect(group).toHaveLength(4);
        for (const transition of group) {
            const [from, to] = transition.split(">");
            const ms = clipMs(`${from}-to-${to}`);
            // The container rounds its duration to the millisecond, give or take one.
            expect(Math.round(ms / frameMs), transition).toBe(48);
        }
        expect(PoseClipMs).toBe(48 * frameMs);
        expect(PoseClipMs).toBeGreaterThan(TonePromptMs);
    });

    it("is given up, not played late, while the face thinks or a clip to or from thinking plays", () => {
        const thinking = trackAfter(trackAfter(StartTrack, "typing", 0), "thinking", 5000);
        expect(thinking.clipUntil).toBe(5000 + PoseClipMs);
        expect(toneDelayMs(thinking, 9000)).toBeNull();
        const step = speechAfterHeard(NoSpeech, { id: "m1", text: "Fine,", tone: "smile" }, 9000, false, thinking);
        expect(step.gesture).toBeNull();
        expect(speakingUntil(step.speech)).toBe(MinSpeakingMs + 9000);

        const back = trackAfter(thinking, "typing", 6000);
        expect(back.clipUntil).toBe(5000 + 2 * PoseClipMs);
        expect(toneDelayMs(back, 5000 + 2 * PoseClipMs - 1)).toBeNull();
        expect(toneDelayMs(back, 5000 + 2 * PoseClipMs)).toBe(AskedFadeMs);
    });

    it("plays on a face that just mounted, which starts on its loop", () => {
        expect(trackAfter(null, "thinking", 100)).toEqual({ talk: "thinking", clipUntil: 0 });
        expect(toneDelayMs(trackAfter(null, "typing", 100), 100)).toBe(AskedFadeMs);
        expect(toneDelayMs(null, 0)).toBe(AskedFadeMs);
    });

    it("keeps a listening to speaking swap free of any clip", () => {
        const track = trackAfter(trackAfter(StartTrack, "typing", 0), "answering", 1000);
        expect(track.clipUntil).toBe(0);
        expect(toneDelayMs(trackAfter(track, null, 2000), 2000)).toBe(AskedFadeMs);
    });
});

describe("he thinks only when it is real (AC86)", () => {
    const idle = { typing: false, busy: false, speaking: false, quietSince: null as number, now: 0 };

    it("listens while the developer writes, and says nothing to his face otherwise", () => {
        expect(talkFace({ ...idle, typing: true }).talk).toBe("typing");
        expect(talkFace(idle).talk).toBeNull();
    });

    it("a quick answer: listening, then speaking, never thinking", () => {
        // Sent at 0; his first words are read at 3 s, under the delay.
        expect(talkFace({ ...idle, busy: true, quietSince: 0, now: 0 })).toEqual({
            talk: "typing",
            wakeAt: ThinkingDelayMs,
        });
        expect(talkFace({ ...idle, busy: true, quietSince: 0, now: 2999 }).talk).toBe("typing");
        expect(talkFace({ ...idle, busy: true, speaking: true, quietSince: null, now: 3000 }).talk).toBe("answering");
        expect(ThinkingDelayMs).toBeGreaterThan(3 * 1500);
    });

    it("a long question or a tool-heavy turn: thinking once nothing has shown for the delay, until his answer starts", () => {
        expect(talkFace({ ...idle, busy: true, quietSince: 0, now: ThinkingDelayMs - 1 }).talk).toBe("typing");
        expect(talkFace({ ...idle, busy: true, quietSince: 0, now: ThinkingDelayMs }).talk).toBe("thinking");
        expect(talkFace({ ...idle, busy: true, quietSince: 0, now: 60000 }).talk).toBe("thinking");
        expect(talkFace({ ...idle, busy: true, speaking: true, quietSince: null, now: 60001 }).talk).toBe("answering");
    });

    it("thinks again when his session keeps working with no new words after he spoke", () => {
        // He spoke until 4 s, his session still works (tool calls).
        expect(talkFace({ ...idle, busy: true, quietSince: 4000, now: 4000 + ThinkingDelayMs - 1 }).talk).toBe(
            "typing"
        );
        expect(talkFace({ ...idle, busy: true, quietSince: 4000, now: 4000 + ThinkingDelayMs }).talk).toBe("thinking");
    });

    it("puts him in the thinking pose only for the thinking talk", () => {
        const open = { working: 0, waiting: 0, cardOpen: true };
        expect(brokkPose({ ...open, talk: "typing" }, { speaking: false, expression: null })).toBe("listening");
        expect(brokkPose({ ...open, talk: "thinking" }, { speaking: false, expression: null })).toBe("thinking");
    });
});
