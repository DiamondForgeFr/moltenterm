// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How Brokk says his answer (FR-BOSS-009, AC86 to AC88, #2259): the words revealed as he speaks, how long his face
// speaks, and when he visibly thinks. A person thinks visibly only about a question that needs it, speaks while the words
// come, and does not make you wait for them: the reveal runs well above reading speed and has a cap. Pure and driven by
// the clock it is handed, so the rules are tested without a wait: brokk-speech.ts sets the timers.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { BrokkExpression, BrokkSituation } from "./brokk-ask-model";
import { ExpressionMs } from "./brokk-queue";
import { BrokkTone, ToneGesture } from "./brokk-tone";

// About three times an average reading speed (some 230 words a minute, about 23 characters a second).
export const RevealCharsPerSecond = 70;
// Whatever arrives is fully shown within this long, however long it is.
export const RevealCapMs = 3000;
// He finishes his sentence: his face speaks this long after the last word shows.
export const SpeakingSettleMs = 1200;
// Speech shorter than this reads as a twitch of the mouth, not as speech.
export const MinSpeakingMs = 2500;
// When the tone's gesture starts (#2259). The package (@diamondforge/character 0.3.1, FR-AI-012) plays an expression
// asked at once on the loop on screen, over a crossfade of AskedFadeMs from wherever the loop is: unlike a gesture drawn
// by chance, it does not wait for the end of a round. What it does wait for is a clip between two poses, which always
// plays to its end: the listening and speaking loops swap without one, but leaving or reaching the thinking pose takes
// one of PoseClipMs (48 frames at 16 fps, brokk-speech-model.test.ts measures them). So the tone plays only when his face
// is on the listening or speaking loop with no such clip under way, and otherwise not at all (the queue gives it up after
// AnswerWaitLimitMs as well): a smile that comes once the developer reads means nothing.
export const AskedFadeMs = 300;
export const PoseClipMs = 3000;
// The tone's gesture starts within this long of his first words, or does not play.
export const TonePromptMs = 500;
// The pace of the reveal's steps while words are being revealed.
export const RevealFrameMs = 40;
// He thinks visibly once nothing of his answer has shown for this long, or his session has worked this long with no new
// words. His answer is read every 1.5 s (brokk-talk-model.ts FollowEveryMs): a quick answer is read within three
// readings, and goes straight from listening to speaking.
export const ThinkingDelayMs = 5000;

// What is said of the latest answer. `from` characters were shown at `startAt`, `to` will be at `endAt`.
export type Speech = {
    // The answer being said (its message's id in the exchange); null before the first one.
    id: string;
    // Its words as known now.
    text: string;
    from: number;
    to: number;
    startAt: number;
    endAt: number;
    // When its first word showed; null when it was never said aloud (it was there before the window listened).
    saidAt: number;
    // Until when the gesture of its tone holds his speech: the gesture first, then he speaks.
    toneUntil: number;
    // The tone of this answer was played (or it had none to play).
    toned: boolean;
};

export const NoSpeech: Speech = {
    id: null,
    text: "",
    from: 0,
    to: 0,
    startAt: 0,
    endAt: 0,
    saidAt: null,
    toneUntil: 0,
    toned: false,
};

// The answer as the exchange holds it.
export type Heard = { id: string; text: string; tone?: BrokkTone };

// An answer already there when the window starts to listen: it is shown whole and said by nobody.
export function alreadySaid(heard: Heard): Speech {
    if (heard == null) {
        return NoSpeech;
    }
    const length = heard.text.length;
    return { ...NoSpeech, id: heard.id, text: heard.text, from: length, to: length, toned: true };
}

function sharedPrefix(a: string, b: string): number {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
        i++;
    }
    return i;
}

// A word is shown whole or not at all: the reveal goes on to the end of the word it reached.
function wordEnd(text: string, at: number): number {
    if (at <= 0) {
        return 0;
    }
    if (at >= text.length) {
        return text.length;
    }
    const next = text.slice(at).search(/\s/);
    return next < 0 ? text.length : at + next;
}

// How many characters show at `now`.
export function shownAt(speech: Speech, now: number): number {
    if (now >= speech.endAt || speech.endAt <= speech.startAt) {
        return Math.min(speech.to, speech.text.length);
    }
    const part = (now - speech.startAt) / (speech.endAt - speech.startAt);
    const raw = speech.from + Math.floor((speech.to - speech.from) * Math.max(part, 0));
    return Math.min(wordEnd(speech.text, raw), speech.to);
}

export function revealingAt(speech: Speech, now: number): boolean {
    return speech.id != null && shownAt(speech, now) < speech.text.length;
}

// Until when his face speaks: the reveal and a settle, at least MinSpeakingMs from his first word, and past the gesture of
// his tone. Null when nothing was said aloud.
export function speakingUntil(speech: Speech): number {
    if (speech.saidAt == null) {
        return null;
    }
    return Math.max(speech.endAt + SpeakingSettleMs, speech.saidAt + MinSpeakingMs, speech.toneUntil);
}

export function speakingAt(speech: Speech, now: number): boolean {
    const until = speakingUntil(speech);
    return until != null && now < until;
}

// The time a part of `chars` characters takes to show.
export function revealMs(chars: number): number {
    return Math.min((Math.max(chars, 0) * 1000) / RevealCharsPerSecond, RevealCapMs);
}

export type SpeechStep = { speech: Speech; gesture: BrokkExpression };

// What his face did with the conversation last, as far as the clips between poses go: `clipUntil` is when the last clip
// to or from the thinking pose ends.
export type FaceTrack = { talk: BrokkSituation["talk"]; clipUntil: number };

export const StartTrack: FaceTrack = { talk: null, clipUntil: 0 };

// The face's talk changed. Only entering or leaving thinking plays a clip between poses; one asked while another plays
// follows it. A face that just mounted (`track` null) starts on its pose's loop, with no clip.
export function trackAfter(track: FaceTrack, talk: BrokkSituation["talk"], now: number): FaceTrack {
    if (track == null) {
        return { talk, clipUntil: 0 };
    }
    if (talk === track.talk) {
        return track;
    }
    if ((talk === "thinking") === (track.talk === "thinking")) {
        return { ...track, talk };
    }
    return { talk, clipUntil: Math.max(track.clipUntil, now) + PoseClipMs };
}

// How long after `now` a gesture asked now would start, or null when it cannot within TonePromptMs: the face thinks, or a
// clip between poses is under way.
export function toneDelayMs(track: FaceTrack, now: number): number {
    if (track != null && (track.talk === "thinking" || now < track.clipUntil)) {
        return null;
    }
    return AskedFadeMs;
}

// More of his answer was read (or a new answer started). `instant`: show it at once (reduced motion). The tone's gesture
// is asked once per answer, with its first words, and only when the face can start it promptly (`track`); otherwise he
// goes straight to speaking.
export function speechAfterHeard(
    speech: Speech,
    heard: Heard,
    now: number,
    instant: boolean,
    track: FaceTrack = StartTrack
): SpeechStep {
    if (heard == null) {
        return { speech, gesture: null };
    }
    const text = heard.text ?? "";
    const same = heard.id === speech.id;
    if (same && text === speech.text) {
        return { speech, gesture: null };
    }
    const shown = same ? Math.min(shownAt(speech, now), sharedPrefix(speech.text, text)) : 0;
    const base: Speech = same ? speech : { ...NoSpeech, id: heard.id };
    if (text === "") {
        return { speech: { ...base, text, from: 0, to: 0, startAt: now, endAt: now }, gesture: null };
    }
    const endAt = instant ? now : now + revealMs(text.length - shown);
    let next: Speech = {
        ...base,
        text,
        from: instant ? text.length : shown,
        to: text.length,
        startAt: now,
        endAt,
        saidAt: base.saidAt ?? now,
    };
    let gesture: BrokkExpression = null;
    if (!next.toned) {
        const delay = toneDelayMs(track, now);
        gesture = delay != null ? (ToneGesture[heard.tone] ?? null) : null;
        next = {
            ...next,
            toned: true,
            toneUntil: gesture != null ? now + delay + ExpressionMs[gesture] + SpeakingSettleMs : 0,
        };
    }
    return { speech: next, gesture };
}

// The developer clicked or typed: the rest shows at once, and he finishes his sentence.
export function speechFlushed(speech: Speech, now: number): Speech {
    if (!revealingAt(speech, now)) {
        return speech;
    }
    const length = speech.text.length;
    return { ...speech, from: length, to: length, startAt: now, endAt: now };
}

// When the reveal or the speech next needs a look: the next step of the words, else the end of his speech.
export function speechWakeAt(speech: Speech, now: number): number {
    if (revealingAt(speech, now)) {
        return Math.min(now + RevealFrameMs, speech.endAt);
    }
    const until = speakingUntil(speech);
    return until != null && until > now ? until : null;
}

export type TalkFaceInput = {
    // The developer has text in the field.
    typing: boolean;
    // A message is on its way or his agent has it, or his own session works.
    busy: boolean;
    // He says his answer (speakingAt).
    speaking: boolean;
    // Since when he has been busy and silent: no word of his shown, or none since his last speech. Null when he is not.
    quietSince: number;
    now: number;
};

// What his face does with the conversation (AC86, AC87): he speaks while he says his answer; busy and silent, he listens
// at first and thinks once that lasts ThinkingDelayMs; otherwise he listens while the developer writes. `wakeAt`: when
// the face changes by itself.
export function talkFace(input: TalkFaceInput): { talk: BrokkSituation["talk"]; wakeAt: number } {
    if (input.speaking) {
        return { talk: "answering", wakeAt: null };
    }
    if (input.busy) {
        const thinksAt = (input.quietSince ?? input.now) + ThinkingDelayMs;
        if (input.quietSince != null && input.now >= thinksAt) {
            return { talk: "thinking", wakeAt: null };
        }
        return { talk: "typing", wakeAt: input.quietSince != null ? thinksAt : null };
    }
    return { talk: input.typing ? "typing" : null, wakeAt: null };
}
