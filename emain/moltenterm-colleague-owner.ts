// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one owner of Brokk as a kind colleague (FR-BOSS-009, AC72 to AC77, #2203, #2221). Each tab of a window is a page of
// its own, so a colleague kept per page counted a stretch per tab (the break never came to a developer who changes tabs),
// raised an evening hand-over in each tab and wrote the meta from several places at once. The run lives here, in Electron
// main, which already reads this computer's idle time: the inputs, the stretch, the moments and what was said. The pages
// tell it what the developer does and what only a page knows (moltenterm-colleague.ts), and show the moments it raises.
//
// Nothing here imports Electron: the clock, the meta, the model and the timer are handed in, so every rule is tested
// without a wait. The rules themselves are the pure ones of brokk-colleague.ts.

import {
    afterInput,
    afterPhrased,
    afterPresence,
    afterSeen,
    afterShown,
    ColleagueFacts,
    ColleagueMemory,
    decodeMemory,
    EmptyColleague,
    encodeMemory,
    evaluate,
    modelPhrasingOn,
    Moment,
    MomentKind,
    TickMs,
    validModelLine,
} from "../frontend/moltenterm-shell/boss/brokk-colleague";
import {
    DefaultPageFacts,
    MomentsUpdate,
    PageFacts,
    samePageFacts,
} from "../frontend/moltenterm-shell/boss/brokk-colleague-wire";

// What outlives a run (the day greeted, the last phrasings...) lives in the client's meta, one text, like the coding agent's
// choice: the pages' localStorage is gone at every restart (#1763), and the meta is the same for every window.
export const ColleagueMetaKey = "moltenterm:brokkcolleague";

// Must match pkg/molten/brokksession/live.go.
export const PhraseRouteId = "molten:brokk";
export const PhraseCommand = "moltenbrokkphrase";
export const PhraseLine = "line";
// A little longer than wavesrv waits for the agent.
export const PhraseTimeoutMs = 30000;

// What his model is told about a moment: nothing that comes from a notification, a file, a pull request or a person.
export type PhraseRequest = {
    kind: MomentKind;
    // The interface language's code.
    language: string;
    // The local time of day, HH:MM.
    clock: string;
    // Hello: the part of the day its written set follows (early, morning, lateMorning, back).
    part?: string;
    // Break: how long the stretch lasted, in minutes.
    workedmin?: number;
    // Hand-over: how many agents work.
    agents?: number;
};

export type PhraseAnswer = { status: string; line?: string };

export type PhraseAsk = (request: PhraseRequest) => Promise<PhraseAnswer>;

export function requestOf(moment: Moment, language: string): PhraseRequest {
    const request: PhraseRequest = { kind: moment.kind, language, clock: moment.clock };
    if (moment.kind === "hello") {
        request.part = moment.set.slice("hello.".length);
    }
    if (moment.kind === "break") {
        request.workedmin = moment.workedMin;
    }
    if (moment.kind === "handover") {
        request.agents = moment.agents;
    }
    return request;
}

export type OwnerDeps = {
    now: () => number;
    random: () => number;
    // Saves the text kept across restarts. Called once for each change.
    write: (text: string) => void;
    ask: PhraseAsk;
    // How long this computer has had no keyboard or pointer input, in seconds (moltenterm-system-idle.ts); null where it
    // cannot be read.
    idleSec: () => Promise<number>;
    // Runs `run` every `ms` and returns the stop.
    every: (ms: number, run: () => void) => () => void;
    // Tells the windows the moments as they now are.
    publish: (update: MomentsUpdate) => void;
};

export class ColleagueOwner {
    private deps: OwnerDeps;
    private memory: ColleagueMemory;
    private saved: string;
    private rev = 0;
    private pageFacts: PageFacts = DefaultPageFacts;
    private stopTimer: () => void = null;

    // `text`: what the meta held, null when it held nothing.
    constructor(deps: OwnerDeps, text: string) {
        this.deps = deps;
        try {
            this.memory = text ? decodeMemory(text) : EmptyColleague;
        } catch {
            this.memory = EmptyColleague;
        }
        this.saved = encodeMemory(this.memory);
    }

    update(): MomentsUpdate {
        return { rev: this.rev, moments: this.memory.moments };
    }

    private facts(): ColleagueFacts {
        return {
            now: this.deps.now(),
            proximity: this.pageFacts.proximity,
            working: this.pageFacts.working,
            random: this.deps.random,
        };
    }

    private save(): void {
        const text = encodeMemory(this.memory);
        if (text === this.saved) {
            return;
        }
        this.saved = text;
        try {
            this.deps.write(text);
        } catch {
            // A write that fails only costs a second greeting after a restart.
        }
    }

    private apply(next: ColleagueMemory): void {
        const prev = this.memory;
        if (next === prev) {
            return;
        }
        this.memory = next;
        if (next.moments === prev.moments) {
            return;
        }
        this.rev += 1;
        this.deps.publish(this.update());
        const known = new Set(prev.moments.map((moment) => moment.id));
        next.moments.filter((moment) => !known.has(moment.id)).forEach((moment) => this.phrase(moment));
    }

    // What a window reports about itself. A change looks at the moments again: the agents that came or went, the setting
    // the developer moved.
    setFacts(facts: PageFacts): void {
        if (samePageFacts(this.pageFacts, facts)) {
            return;
        }
        this.pageFacts = facts;
        this.apply(evaluate(this.memory, this.facts()));
        this.save();
    }

    // An input of the developer in any view of any window.
    noteInput(facts: PageFacts): void {
        if (!samePageFacts(this.pageFacts, facts)) {
            this.pageFacts = facts;
        }
        this.apply(afterInput(this.memory, this.facts()));
        this.save();
    }

    // The clock alone: a stretch that reached its length, an evening that began, a moment that lapsed.
    tick(): void {
        this.apply(evaluate(this.memory, this.facts()));
        this.save();
        this.readPresence();
    }

    // This computer's idle time tells a presence the pages cannot see: input in another application, and the developer
    // back after a sleep (#2216).
    readPresence(): void {
        let reading: Promise<number>;
        try {
            reading = Promise.resolve(this.deps.idleSec());
        } catch {
            return;
        }
        reading
            .then((sec) => {
                if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) {
                    return;
                }
                const facts = this.facts();
                this.apply(afterPresence(this.memory, facts.now - sec * 1000, facts));
                this.save();
            })
            .catch(() => {});
    }

    // The clock runs while a window listens: at least one page has started.
    setListening(listening: boolean): void {
        if (listening === (this.stopTimer != null)) {
            return;
        }
        if (!listening) {
            this.stopTimer();
            this.stopTimer = null;
            return;
        }
        this.stopTimer = this.deps.every(TickMs, () => this.tick());
        this.readPresence();
    }

    // A window puts the moment on screen. The first to ask has it: the moment as it now is (its words may have changed
    // with the part of the day), null when another window showed it already or it is gone.
    noteShown(id: string): Moment {
        const moment = this.memory.moments.find((m) => m.id === id);
        if (moment == null || moment.shownAt != null) {
            return null;
        }
        this.apply(afterShown(this.memory, id, this.deps.now()));
        this.save();
        return this.memory.moments.find((m) => m.id === id) ?? null;
    }

    // The developer has seen the moment and the group or the bubble closed: it does not come back, in any window.
    noteSeen(id: string): void {
        this.apply(afterSeen(this.memory, id));
        this.save();
    }

    // His model may phrase a moment, once. The written phrasing shows meanwhile and until the moment is first shown;
    // anything that goes wrong leaves it as it is. How many times a day he is asked is counted by wavesrv, where the call
    // is made (pkg/molten/brokksession/phrase.go): a call past the day's budget comes back with no line.
    private phrase(moment: Moment): void {
        if (!modelPhrasingOn(this.pageFacts.proximity)) {
            return;
        }
        const request = requestOf(moment, this.pageFacts.language);
        const answered = (answer: PhraseAnswer) => {
            const line = answer?.status === PhraseLine ? validModelLine(answer.line) : null;
            if (line != null) {
                this.apply(afterPhrased(this.memory, moment.id, line));
            }
        };
        const failed = (e: unknown) => console.log("brokk colleague: his model could not phrase a moment", e);
        try {
            Promise.resolve(this.deps.ask(request)).then(answered).catch(failed);
        } catch (e) {
            failed(e);
        }
    }
}

// Writes the meta one text at a time, in order. A text that comes while one is on its way waits, and only the latest of
// the waiting ones is sent: each write is a request of its own, and two in flight can reach wavesrv in either order (the
// audit #2214 saw them swapped).
export function makeSerialWriter(
    send: (text: string) => Promise<unknown>,
    onError: (e: unknown) => void = () => {}
): (text: string) => void {
    let sending = false;
    let waiting: string = null;
    const pump = (text: string) => {
        sending = true;
        let reply: Promise<unknown>;
        try {
            reply = Promise.resolve(send(text));
        } catch (e) {
            reply = Promise.reject(e);
        }
        reply.catch(onError).finally(() => {
            sending = false;
            if (waiting == null) {
                return;
            }
            const next = waiting;
            waiting = null;
            pump(next);
        });
    };
    return (text) => {
        if (sending) {
            waiting = text;
            return;
        }
        pump(text);
    };
}
