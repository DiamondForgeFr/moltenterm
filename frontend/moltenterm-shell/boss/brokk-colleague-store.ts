// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk as a kind colleague (FR-BOSS-009, AC72 to AC77, #2203): it keeps the memory of
// brokk-colleague.ts, feeds it the developer's inputs and the agents at work, saves what has to outlive a run, and, under
// Colleague, asks his model to phrase each moment once. The inputs come from the one listener the expressions watch
// already owns (brokk-expressions.ts): this file adds no activity tracker of its own.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { ClientModel } from "@/app/store/client-model";
import { getApi, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { AgentStates } from "../agent-state-store";
import { getLocale } from "../i18n/i18n";
import { TabActivity, whileShown } from "../tab-activity";
import {
    afterInput,
    afterModelCall,
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
    laterPresence,
    modelCallAllowed,
    modelPhrasingOn,
    Moment,
    MomentKind,
    Proximity,
    proximityOf,
    ProximitySettingKey,
    TickMs,
    validModelLine,
} from "./brokk-colleague";
import { workingOf } from "./brokk-watch";

// What outlives a run (the day greeted, the last phrasings...) lives in the client's meta, one text, like the coding agent's
// choice: the pages' localStorage is gone at every restart (#1763), and the meta is shared by every window at once.
export const ColleagueMetaKey = "moltenterm:brokkcolleague";
// A write whose echo has not come back after this long is dropped, so that a failed write cannot hide the other windows'.
export const WriteEchoMs = 30000;

// Must match pkg/molten/brokksession/live.go.
export const PhraseRouteId = "molten:brokk";
export const PhraseCommand = "moltenbrokkphrase";
export const PhraseLine = "line";
// A little longer than wavesrv waits for the agent.
export const PhraseTimeoutMs = 30000;
// Pointer moves arrive by the hundred: one reading a second is plenty for a stretch counted in minutes.
export const InputEveryMs = 1000;

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

const LiveAsk: PhraseAsk = (request) =>
    TabRpcClient.wshRpcCall(PhraseCommand, request, { route: PhraseRouteId, timeout: PhraseTimeoutMs });

export type ColleagueDeps = {
    now: () => number;
    random: () => number;
    // The text kept across restarts, null when there is none; and its writing.
    read: () => string;
    write: (text: string) => void;
    ask: PhraseAsk;
    language: () => string;
    proximity: () => Proximity;
    working: () => number;
    // How long this computer has had no keyboard or pointer input, in seconds (emain/moltenterm-system-idle.ts); null
    // where it cannot be read.
    idleSec: () => Promise<number>;
    // Runs `run` every `ms` and returns the stop: the app's one scheduler, paused where the view is not on screen.
    every: (ms: number, run: () => void) => () => void;
};

function liveRead(): string {
    const clientAtom = ClientModel.getInstance().clientAtom;
    const value = (clientAtom != null ? globalStore.get(clientAtom) : null)?.meta?.[ColleagueMetaKey];
    return typeof value === "string" ? value : null;
}

function liveWrite(text: string): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("client", clientId),
            meta: { [ColleagueMetaKey]: text } as MetaType,
        })
    );
}

const LiveDeps: ColleagueDeps = {
    now: () => Date.now(),
    random: () => Math.random(),
    read: liveRead,
    write: liveWrite,
    ask: LiveAsk,
    language: () => getLocale(),
    proximity: () => proximityOf(globalStore.get(getSettingsKeyAtom(ProximitySettingKey as keyof SettingsType))),
    working: () => workingOf(globalStore.get(AgentStates.getInstance().dataAtom)),
    idleSec: () => {
        const ask = getApi()?.moltentermGetSystemIdleSec;
        return ask == null ? Promise.resolve(null) : ask();
    },
    every: (ms, run) => TabActivity.getInstance().every(whileShown(ms), run, "brokk-colleague"),
};

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

export class BrokkColleagueModel {
    private static instance: BrokkColleagueModel = null;

    // The moments waiting to be shown, oldest first (currentMoment picks the one to show).
    momentsAtom = atom([]) as PrimitiveAtom<Moment[]>;

    private deps: ColleagueDeps = LiveDeps;
    private memory: ColleagueMemory = EmptyColleague;
    private loaded = false;
    private saved = "";
    // What this window wrote and the meta has not echoed yet.
    private pending: { text: string; at: number } = null;
    private lastInputAt: number = null;

    private constructor() {}

    static getInstance(): BrokkColleagueModel {
        if (BrokkColleagueModel.instance == null) {
            BrokkColleagueModel.instance = new BrokkColleagueModel();
        }
        return BrokkColleagueModel.instance;
    }

    static resetInstance(): void {
        BrokkColleagueModel.instance = null;
    }

    // Tests give a clock, a random source, a meta and a model of their own.
    useDeps(deps: Partial<ColleagueDeps>): void {
        this.deps = { ...LiveDeps, ...deps };
        this.loaded = false;
        this.pending = null;
        this.lastInputAt = null;
        this.memory = EmptyColleague;
        globalStore.set(this.momentsAtom, []);
    }

    private load(): void {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        this.pending = null;
        try {
            const text = this.deps.read();
            this.memory = text ? decodeMemory(text) : EmptyColleague;
        } catch {
            this.memory = EmptyColleague;
        }
        this.saved = encodeMemory(this.memory);
    }

    // Another window of this computer shares the greeting and the phrasings (one meta): what it saved since is read before
    // a moment is raised, so that the same hello is not said in each window. While this window's own write has not come
    // back, the meta is older than the memory and is not read.
    private reload(): void {
        try {
            const text = this.deps.read();
            if (this.pending != null) {
                if (text === this.pending.text) {
                    this.pending = null;
                } else if (this.deps.now() - this.pending.at < WriteEchoMs) {
                    return;
                } else {
                    this.pending = null;
                }
            }
            if (!text || text === this.saved) {
                return;
            }
            const other = decodeMemory(text);
            this.memory = {
                ...this.memory,
                helloDay: other.helloDay,
                last: other.last,
                handoverEvening: other.handoverEvening,
                modelDay: other.modelDay,
                modelCalls: other.modelCalls,
                presentAt: laterPresence(this.memory.presentAt, other.presentAt),
            };
            this.saved = text;
        } catch {
            // A meta that cannot be read leaves what this window knows.
        }
    }

    private facts(): ColleagueFacts {
        return {
            now: this.deps.now(),
            proximity: this.deps.proximity(),
            working: this.deps.working(),
            random: this.deps.random,
        };
    }

    private save(): void {
        const text = encodeMemory(this.memory);
        if (text === this.saved) {
            return;
        }
        this.saved = text;
        this.pending = { text, at: this.deps.now() };
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
        this.save();
        if (next.moments === prev.moments) {
            return;
        }
        globalStore.set(this.momentsAtom, next.moments);
        const known = new Set(prev.moments.map((moment) => moment.id));
        next.moments.filter((moment) => !known.has(moment.id)).forEach((moment) => this.phrase(moment));
    }

    // An input of the developer, told by the expressions watch.
    noteInput(): void {
        const now = this.deps.now();
        if (this.lastInputAt != null && now - this.lastInputAt < InputEveryMs) {
            return;
        }
        this.lastInputAt = now;
        this.load();
        this.reload();
        this.apply(afterInput(this.memory, this.facts()));
    }

    // The clock alone: a stretch that reached its length, an evening that began, a moment that lapsed.
    tick(): void {
        this.load();
        this.reload();
        this.apply(evaluate(this.memory, this.facts()));
        this.readPresence();
    }

    // This computer's idle time tells a presence the page cannot see: input in another view or another application, and
    // the developer back after a sleep (#2216).
    private readPresence(): void {
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
                this.load();
                this.reload();
                const facts = this.facts();
                this.apply(afterPresence(this.memory, facts.now - sec * 1000, facts));
            })
            .catch(() => {});
    }

    noteShown(id: string): void {
        this.load();
        this.apply(afterShown(this.memory, id, this.deps.now()));
    }

    // The group closed on a moment the developer saw: it does not come back.
    noteSeen(id: string): void {
        this.load();
        this.apply(afterSeen(this.memory, id));
    }

    // His model may phrase a moment, once. The written phrasing shows meanwhile and until the moment is first shown;
    // anything that goes wrong leaves it as it is.
    private phrase(moment: Moment): void {
        const now = this.deps.now();
        if (!modelPhrasingOn(this.deps.proximity()) || !modelCallAllowed(this.memory, now)) {
            return;
        }
        this.apply(afterModelCall(this.memory, now));
        const request = requestOf(moment, this.deps.language());
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

    // Listens while the avatar is on screen: the clock, the agents at work and the setting. Returns the stop.
    start(): () => void {
        this.load();
        this.readPresence();
        const stopTimer = this.deps.every(TickMs, () => this.tick());
        const stopAgents = globalStore.sub(AgentStates.getInstance().dataAtom, () => this.tick());
        const stopSetting = globalStore.sub(getSettingsKeyAtom(ProximitySettingKey as keyof SettingsType), () =>
            this.tick()
        );
        return () => {
            stopTimer();
            stopAgents();
            stopSetting();
        };
    }
}
