// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk says his answer (FR-BOSS-009, AC87, AC88, #2259): while his group shows, his latest answer is revealed as it is
// read from his session (brokk-session.ts), his face speaks for as long as the words come, and the tone he tagged it with
// plays first, through the one expression queue (brokk-expressions.ts). A click or a key anywhere shows the rest at
// once; with reduced motion it shows at once. The rules are brokk-speech-model.ts's.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import type { BrokkSituation } from "./brokk-ask-model";
import { BrokkItem, ExchangeItem } from "./brokk-exchange-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkSession } from "./brokk-session";
import {
    alreadySaid,
    FaceTrack,
    Heard,
    NoSpeech,
    shownAt,
    speakingAt,
    Speech,
    speechAfterHeard,
    speechFlushed,
    speechWakeAt,
    StartTrack,
    trackAfter,
} from "./brokk-speech-model";

// The answer being revealed and how many of its characters show; id null when none is.
export type Shown = { id: string; count: number };

export const NothingShown: Shown = { id: null, count: 0 };

export type SpeechTarget = {
    addEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
    removeEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
};

type Timer = { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void };

const LiveTimer: Timer = {
    set: (run, ms) => setTimeout(run, ms),
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// The latest answer of his in the exchange: the one he is saying.
export function latestAnswer(items: ExchangeItem[]): Heard {
    for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
        const item = items[i];
        if (item.role === "brokk") {
            const said = item as BrokkItem;
            return { id: said.id, text: said.text, tone: said.tone };
        }
    }
    return null;
}

export class BrokkSpeech {
    private static instance: BrokkSpeech = null;

    // The answer being revealed: the exchange shows only `count` characters of it.
    shownAtom = atom(NothingShown) as PrimitiveAtom<Shown>;
    // His face says his answer.
    speakingAtom = atom(false) as PrimitiveAtom<boolean>;

    speech: Speech = NoSpeech;
    // What his face did last with the conversation: whether the tone of an answer can start at once.
    track: FaceTrack = StartTrack;
    private timer: Timer = LiveTimer;
    private wake: unknown = null;
    private now: () => number = () => Date.now();
    private watching = 0;

    private constructor() {}

    static getInstance(): BrokkSpeech {
        if (BrokkSpeech.instance == null) {
            BrokkSpeech.instance = new BrokkSpeech();
        }
        return BrokkSpeech.instance;
    }

    static resetInstance(): void {
        const instance = BrokkSpeech.instance;
        if (instance != null) {
            instance.timer.clear(instance.wake);
        }
        BrokkSpeech.instance = null;
    }

    // Tests give a clock and timers of their own.
    useClock(now: () => number, timer: Timer): void {
        this.now = now;
        this.timer = timer;
    }

    private instant(): boolean {
        return globalStore.get(atoms.prefersReducedMotionAtom) === true;
    }

    // Draws what the speech says at this moment, and sets the next look.
    private draw(): void {
        this.timer.clear(this.wake);
        this.wake = null;
        const now = this.now();
        const speech = this.speech;
        const count = shownAt(speech, now);
        const shown: Shown = count < speech.text.length ? { id: speech.id, count } : NothingShown;
        const before = globalStore.get(this.shownAtom);
        if (before.id !== shown.id || before.count !== shown.count) {
            globalStore.set(this.shownAtom, shown);
        }
        const speaking = speakingAt(speech, now);
        if (globalStore.get(this.speakingAtom) !== speaking) {
            globalStore.set(this.speakingAtom, speaking);
        }
        const wakeAt = speechWakeAt(speech, now);
        if (wakeAt != null && this.watching > 0) {
            this.wake = this.timer.set(() => this.draw(), Math.max(wakeAt - now, 0));
        }
    }

    // More of his answer was read.
    heard(items: ExchangeItem[]): void {
        const step = speechAfterHeard(this.speech, latestAnswer(items), this.now(), this.instant(), this.track);
        if (step.speech === this.speech) {
            return;
        }
        this.speech = step.speech;
        if (step.gesture != null) {
            BrokkExpressionsModel.getInstance().ask(step.gesture, { answer: true });
        }
        this.draw();
    }

    // What his group's face does with the conversation (use-brokk-talk-face.ts), told as it changes.
    noteFace(talk: BrokkSituation["talk"]): void {
        this.track = trackAfter(this.track, talk, this.now());
    }

    // A click or a key: the rest of his answer shows at once.
    flush(): void {
        const next = speechFlushed(this.speech, this.now());
        if (next === this.speech) {
            return;
        }
        this.speech = next;
        this.draw();
    }

    // Follows his answers while his group shows. What is already in the exchange is shown whole and said by nobody: he
    // says only what arrives while the developer is there. Returns the stop.
    watch(target: SpeechTarget = globalThis.document): () => void {
        const session = BrokkSession.getInstance();
        this.watching++;
        if (this.watching === 1) {
            this.speech = alreadySaid(latestAnswer(globalStore.get(session.exchangeAtom)));
            this.track = null;
            this.draw();
        }
        const stopExchange = globalStore.sub(session.exchangeAtom, () =>
            this.heard(globalStore.get(session.exchangeAtom))
        );
        const stopMotion = globalStore.sub(atoms.prefersReducedMotionAtom, () => {
            if (this.instant()) {
                this.flush();
            }
        });
        const onInput = () => this.flush();
        const options = { capture: true, passive: true };
        target?.addEventListener("keydown", onInput, options);
        target?.addEventListener("pointerdown", onInput, options);
        return () => {
            stopExchange();
            stopMotion();
            target?.removeEventListener("keydown", onInput, options);
            target?.removeEventListener("pointerdown", onInput, options);
            this.watching--;
            if (this.watching === 0) {
                this.flush();
                this.timer.clear(this.wake);
                this.wake = null;
                globalStore.set(this.shownAtom, NothingShown);
                globalStore.set(this.speakingAtom, false);
            }
        };
    }
}
