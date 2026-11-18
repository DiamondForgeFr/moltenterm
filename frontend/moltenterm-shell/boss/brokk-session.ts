// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk's own terminal session (FR-BOSS-009, AC15, AC23 and AC99, #2003, #2033, #2382): his talk.
// There is one Brokk, so one conversation: wavesrv keeps it (pkg/molten/brokksession/talk.go), with the exchange, the
// state of the last message, the message waiting for him and the request his agent waits on, and follows his answers
// there. Every tab of every window and workspace is a page of its own; each one shows that same talk. A page reads it
// after each signal (TalkEvent, a revision number only) and after each of its own moves, and its atoms hold what it
// read. Nothing starts without a message the developer sends.
//
// What a page's own brainstorm listens to (his answers as they are read, the messages his agent took) is told in the
// page that sent the message alone, as it was before the talk moved to wavesrv: another page shows the exchange, and
// leaves the brainstorm's turns to the page that holds them.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { TabActivity, whileShown } from "../tab-activity";
import { BossBubbleModel } from "./boss-store";
import { ExchangeItem, parseReply } from "./brokk-exchange-model";
import { BrokkHubModel } from "./brokk-hub-store";
import {
    AutoApproval,
    IdleTalk,
    PermissionAsk,
    PermitDecision,
    PermitStatus,
    QueuedMessage,
    SendingTalk,
    TalkState,
    talkStateOfWire,
    TalkStateWire,
} from "./brokk-talk-model";

// must match pkg/molten/brokksession/live.go and talk.go
export const SessionRouteId = "molten:brokk";
export const SessionCommand = "moltenbrokksession";
export const PermitCommand = "moltenbrokkpermit";
export const TalkCommand = "moltenbrokktalk";
export const TalkSayCommand = "moltenbrokktalksay";
export const TalkOpCommand = "moltenbrokktalkop";
export const TalkEvent = "molten:brokktalk";

const FindTimeoutMs = 8000;
// wavesrv waits up to 90 s for an agent just started to show its prompt, and may read the answer before to its end.
const SayTimeoutMs = 130000;
// A page whose talk window stays open says so again this often: wavesrv forgets an open window after 5 minutes.
const WindowRenewMs = 60000;

type Call = (command: string, data: Record<string, unknown>, timeoutMs: number) => Promise<any>;

const LiveCall: Call = (command, data, timeout) =>
    TabRpcClient.wshRpcCall(command, data, { route: SessionRouteId, timeout });

// His answer as it is read, for what follows his conversation (the brainstorm of FR-BOSS-010, #2246): the message it
// answers, what he has written so far, its turn in his transcript, and whether his agent is done with it.
export type AnswerRead = { id: string; you: string; markdown: string; turn: number; final: boolean };

export type AnswerListener = (answer: AnswerRead) => void;

// The conversations of his talk window (FR-BOSS-010 AC24, #2285): his ordinary one, and the brainstorm's, which never
// shows in the other.
export type ConversationKey = "main" | "brainstorm";

// must match TalkEntry and TalkView in pkg/molten/brokksession/talk.go
export type TalkEntry = {
    id: string;
    role: "you" | "brokk";
    text?: string;
    markdown?: string;
    turn?: number;
    at: number;
    final?: boolean;
    still?: boolean;
    taken?: boolean;
    origin?: string;
};

export type TalkView = {
    rev: number;
    instance: string;
    conversation: ConversationKey;
    main: TalkEntry[];
    brainstorm: TalkEntry[];
    state: TalkStateWire;
    waiting?: { text: string; since: number; conversation: ConversationKey }[];
    returned?: Partial<Record<ConversationKey, string>>;
    lead?: string;
    permission?: PermissionAsk;
    permissiongone?: boolean;
    approved?: AutoApproval[];
    unseen?: string;
    blockid?: string;
    inflight?: ConversationKey[];
};

// The same state read again draws nothing again.
function sameTalkState(a: TalkState, b: TalkState): boolean {
    return (
        a.phase === b.phase &&
        a.reason === b.reason &&
        a.agentName === b.agentName &&
        a.started === b.started &&
        a.reply === b.reply &&
        a.where?.blockid === b.where?.blockid &&
        a.where?.tabid === b.where?.tabid &&
        a.where?.workspaceid === b.where?.workspaceid
    );
}

// What a page has told its listeners of an entry: an answer's words, its turn and whether it was complete.
function heardOf(entry: TalkEntry): string {
    return `${entry.turn ?? 0}|${entry.final === true}|${entry.markdown ?? ""}`;
}

// The exchange as the window shows it, the items kept as they were while their entry did not change.
export function itemsOf(entries: TalkEntry[], before: ExchangeItem[]): ExchangeItem[] {
    const known = new Map<string, ExchangeItem>((before ?? []).map((item) => [`${item.role}:${item.id}`, item]));
    let same = (before?.length ?? -1) === (entries?.length ?? 0);
    const items = (entries ?? []).map((entry, i) => {
        const prior = known.get(`${entry.role}:${entry.id}`);
        const item = itemOf(entry, prior);
        same = same && item === before[i];
        return item;
    });
    return same ? before : items;
}

function itemOf(entry: TalkEntry, prior: ExchangeItem): ExchangeItem {
    if (entry.role === "you") {
        const text = entry.text ?? "";
        if (prior?.role === "you" && prior.text === text && prior.at === entry.at) {
            return prior;
        }
        return { id: entry.id, role: "you", text, at: entry.at };
    }
    const final = entry.final === true;
    const parsed = parseReply(entry.markdown ?? "", final);
    const actions = final && entry.still !== true ? parsed.actions : [];
    if (
        prior?.role === "brokk" &&
        prior.text === parsed.text &&
        prior.final === final &&
        prior.turn === (entry.turn ?? 0) &&
        prior.tone === parsed.tone &&
        prior.actions.length === actions.length
    ) {
        return prior;
    }
    return {
        id: entry.id,
        role: "brokk",
        text: parsed.text,
        actions,
        at: entry.at,
        turn: entry.turn ?? 0,
        final,
        tone: parsed.tone,
    };
}

export class BrokkSession {
    private static instance: BrokkSession = null;

    // The status of the last message, for the notes of the window.
    stateAtom = atom(IdleTalk) as PrimitiveAtom<TalkState>;
    // The developer's messages and his answers in the conversation on screen, oldest first, for as long as MoltenTerm
    // runs.
    exchangeAtom = atom([]) as PrimitiveAtom<ExchangeItem[]>;
    // Which conversation the window shows (#2285).
    conversationAtom = atom("main") as PrimitiveAtom<ConversationKey>;
    // His answer that changed while no window had the talk open: his line under the square (AC25). Null when seen.
    unseenIdAtom = atom(null) as PrimitiveAtom<string>;
    // What his agent asks the developer now, a permission or a question, answered in his talk window (#2257, AC100).
    permissionAtom = atom(null) as PrimitiveAtom<PermissionAsk>;
    // The developer's answer did not reach it: the request was over (answered in his terminal, or no longer asked).
    permissionGoneAtom = atom(false) as PrimitiveAtom<boolean>;
    // What boss:autoapprove let through, each shown once as a line in his talk window.
    approvedAtom = atom([]) as PrimitiveAtom<AutoApproval[]>;
    // The message waiting for him in the conversation on screen (#2284, #2285); null when none waits there.
    queuedAtom = atom(null) as PrimitiveAtom<QueuedMessage>;
    // Text a Cancel or a failure gave back to the field of the conversation on screen, until a field takes it.
    returnedAtom = atom(null) as PrimitiveAtom<string>;

    private call: Call = LiveCall;
    private instanceId: string = null;
    private rev = -1;
    private view: TalkView = null;
    private reading: Promise<void> = null;
    private readAgain = false;
    private started = 0;
    private stopSignal: () => void = null;
    private answerListeners = new Set<AnswerListener>();
    private takenListeners = new Set<(id: string, conversation: ConversationKey) => void>();
    // What this page told its listeners, by entry; filled silently by the first reading.
    private heard = new Map<string, string>();
    // The moves of the brainstorm go in the order they were made, and a message after them.
    private moves: Promise<unknown> = Promise.resolve();
    private lead = "";
    private windowOpen = false;
    private windowTimer: () => void = null;
    private clearing = false;

    static getInstance(): BrokkSession {
        if (BrokkSession.instance == null) {
            BrokkSession.instance = new BrokkSession();
        }
        return BrokkSession.instance;
    }

    static resetInstance(): void {
        BrokkSession.instance?.stop();
        BrokkSession.instance = null;
    }

    // Tests give a call of their own.
    useCall(call: Call): void {
        this.call = call;
    }

    // This page, by its tab: its listeners alone hear what it sent.
    private origin(): string {
        return globalStore.get(atoms.staticTabId) ?? "";
    }

    // Each reading of his answer to a message this page sent, while it comes in and once it is complete. Returns the
    // stop.
    listenAnswers(listener: AnswerListener): () => void {
        this.answerListeners.add(listener);
        return () => this.answerListeners.delete(listener);
    }

    // Each message this page sent that his agent took, by the id its answer will carry and the conversation it was
    // written in, before any word of it (the brainstorm notes where it began, #2284, #2285). Returns the stop.
    listenTaken(listener: (id: string, conversation: ConversationKey) => void): () => void {
        this.takenListeners.add(listener);
        return () => this.takenListeners.delete(listener);
    }

    // Starts reading the talk: at once, after each signal, and when the page comes back in view (a signal may have been
    // missed while it was away). Returns the stop.
    start(): () => void {
        this.started++;
        if (this.started === 1) {
            try {
                this.stopSignal = waveEventSubscribeSingle({
                    eventType: TalkEvent as WaveEventName,
                    handler: (event) => this.signal((event?.data as { rev?: number })?.rev),
                });
            } catch (e) {
                console.log("brokk session: no event bus", e);
            }
            globalThis.document?.addEventListener("visibilitychange", this.onVisibility);
            void this.refresh();
        }
        return () => {
            this.started--;
            if (this.started === 0) {
                this.stop();
            }
        };
    }

    private stop(): void {
        this.stopSignal?.();
        this.stopSignal = null;
        globalThis.document?.removeEventListener("visibilitychange", this.onVisibility);
        this.setWindowTimer(false);
    }

    private onVisibility = () => {
        if (globalThis.document?.visibilityState === "visible") {
            void this.refresh();
        }
        this.tellWindow();
    };

    private signal(rev: number): void {
        if (typeof rev === "number" && this.instanceId != null && rev <= this.rev) {
            return;
        }
        void this.refresh();
    }

    // Reads the talk, one reading at a time: a signal during a reading reads once more after it.
    refresh(): Promise<void> {
        if (this.reading != null) {
            this.readAgain = true;
            return this.reading;
        }
        this.reading = this.readLoop();
        return this.reading;
    }

    // The loop ends and lets the next signal read in the same step: a signal never falls between them.
    private async readLoop(): Promise<void> {
        try {
            do {
                this.readAgain = false;
                try {
                    this.apply(await this.call(TalkCommand, {}, FindTimeoutMs));
                } catch (e) {
                    console.log("brokk session: his talk could not be read", e);
                }
            } while (this.readAgain);
        } finally {
            this.reading = null;
        }
    }

    // A talk read from wavesrv; an older one than the page has is dropped. A restarted wavesrv counts its revisions from
    // 0 again, so only a talk of the same wavesrv is compared.
    apply(view: TalkView): void {
        if (view == null || typeof view.rev !== "number") {
            return;
        }
        const sameServer = view.instance === this.instanceId;
        if (sameServer && view.rev < this.rev) {
            return;
        }
        const first = this.instanceId == null;
        this.instanceId = view.instance;
        this.rev = view.rev;
        this.view = view;
        this.tell(view, first || !sameServer);
        const key: ConversationKey = view.conversation === "brainstorm" ? "brainstorm" : "main";
        const entries = key === "brainstorm" ? view.brainstorm : view.main;
        if (globalStore.get(this.conversationAtom) !== key) {
            globalStore.set(this.conversationAtom, key);
        }
        const before = globalStore.get(this.exchangeAtom);
        const items = itemsOf(entries ?? [], before);
        if (items !== before) {
            globalStore.set(this.exchangeAtom, items);
        }
        const state = talkStateOfWire(view.state);
        if (!sameTalkState(globalStore.get(this.stateAtom), state)) {
            globalStore.set(this.stateAtom, state);
        }
        const mine = (view.waiting ?? []).find((w) => w.conversation === key);
        const queued = globalStore.get(this.queuedAtom);
        if (mine == null) {
            globalStore.set(this.queuedAtom, null);
        } else if (queued?.text !== mine.text || queued?.since !== mine.since) {
            globalStore.set(this.queuedAtom, { text: mine.text, since: mine.since });
        }
        globalStore.set(this.returnedAtom, view.returned?.[key] ?? null);
        const ask = view.permission ?? null;
        if (globalStore.get(this.permissionAtom)?.id !== ask?.id) {
            globalStore.set(this.permissionAtom, ask);
        }
        globalStore.set(this.permissionGoneAtom, view.permissiongone === true);
        const approved = view.approved ?? [];
        if (approved.length !== globalStore.get(this.approvedAtom).length) {
            globalStore.set(this.approvedAtom, approved);
        }
        globalStore.set(this.unseenIdAtom, view.unseen || null);
        this.lead = view.lead ?? "";
        if (view.blockid) {
            globalStore.set(BrokkHubModel.getInstance().sessionBlockAtom, view.blockid);
        }
        // A page that shows the talk open sees his answer: his line goes. A hidden page says nothing of it.
        if (view.unseen && this.windowOpen && this.visible()) {
            this.tellWindow();
        }
    }

    private visible(): boolean {
        return globalThis.document == null || globalThis.document.visibilityState !== "hidden";
    }

    // Tells this page's listeners what changed in the messages it sent; the first reading only learns what is there.
    private tell(view: TalkView, silent: boolean): void {
        const origin = this.origin();
        for (const key of ["main", "brainstorm"] as ConversationKey[]) {
            const entries = (key === "brainstorm" ? view.brainstorm : view.main) ?? [];
            for (const entry of entries) {
                if (!entry.origin || entry.origin !== origin) {
                    continue;
                }
                const mark = `${entry.role}:${entry.id}`;
                const now = entry.role === "you" ? (entry.taken ? "taken" : "sent") : heardOf(entry);
                if (this.heard.get(mark) === now) {
                    continue;
                }
                const was = this.heard.get(mark);
                this.heard.set(mark, now);
                if (silent) {
                    continue;
                }
                if (entry.role === "you") {
                    if (entry.taken && was !== "taken") {
                        this.takenListeners.forEach((listener) => this.safely(() => listener(entry.id, key)));
                    }
                    continue;
                }
                const you = entries.find((e) => e.role === "you" && e.id === entry.id)?.text ?? "";
                const answer: AnswerRead = {
                    id: entry.id,
                    you,
                    markdown: entry.markdown ?? "",
                    turn: entry.turn ?? 0,
                    final: entry.final === true,
                };
                this.answerListeners.forEach((listener) => this.safely(() => listener(answer)));
            }
        }
    }

    private safely(fn: () => void): void {
        try {
            fn();
        } catch (e) {
            console.log("brokk session: a listener of his talk failed", e);
        }
    }

    private async op(data: Record<string, unknown>): Promise<string> {
        try {
            const result = await this.call(TalkOpCommand, data, FindTimeoutMs);
            this.apply(result?.view);
            return result?.text ?? null;
        } catch (e) {
            console.log("brokk session: a move on his talk did not go", data.op, e);
            return null;
        }
    }

    // A move of the brainstorm, after the ones before it.
    private move(data: Record<string, unknown>): Promise<string> {
        const next = this.moves.then(() => this.op(data));
        this.moves = next.catch(() => null);
        return next;
    }

    // The words the developer's next message starts with (setLead): the brainstorm puts the note of their graph changes
    // after its own (#2247).
    leadOf(): string {
        return this.lead;
    }

    setLead(lead: string): void {
        this.lead = lead ?? "";
        void this.move({ op: "lead", text: this.lead });
    }

    // A line of his that MoltenTerm says for him, with no message behind it (the brainstorm's opening, #2246).
    addLocalLine(text: string): void {
        void this.move({ op: "local", text });
    }

    // The conversation of a brainstorm the developer moved to (#2248), each line as it was kept.
    showConversation(turns: { role: string; text: string; at: number }[]): void {
        void this.move({ op: "show", turns: turns ?? [] });
    }

    // A message of `key`'s conversation waits for him, or is still answered (#2285).
    hasInFlight(key: ConversationKey): boolean {
        return this.view?.inflight?.includes(key) === true;
    }

    // The developer moved to another brainstorm (#2248): the answer still coming belongs to the one left.
    stopFollowing(): void {
        void this.move({ op: "stop" });
    }

    // The window moves to another conversation (FR-BOSS-010 AC24, #2285); `carry` names a message whose exchange moves
    // with it (his answer that opened the brainstorm).
    switchConversation(key: ConversationKey, opts: { carry?: string; fresh?: boolean } = {}): void {
        void this.move({ op: "switch", conversation: key, carry: opts.carry ?? "", fresh: opts.fresh === true });
    }

    // The developer moved to another brainstorm (#2285): a message still waiting from the one left comes back.
    returnWaiting(key: ConversationKey): void {
        void this.move({ op: "return", conversation: key });
    }

    // The scripted replay of a brainstorm (dev and local builds, #2246), read the way a real answer is.
    replayStep(key: string, you: string, markdown: string, turn: number, final: boolean): void {
        void this.move({ op: "replay", key, you, markdown, turn, final, origin: this.origin() });
    }

    // Finds the session a restart left, so that the ring turns for it. Starts nothing.
    async find(): Promise<void> {
        try {
            const result = await this.call(SessionCommand, {}, FindTimeoutMs);
            if (result?.status === "ready" && result.blockid) {
                globalStore.set(BrokkHubModel.getInstance().sessionBlockAtom, result.blockid);
            }
        } catch (e) {
            console.log("brokk session: not found", e);
        }
    }

    // The talk window opens or folds: while a page shows it open, his answers are seen there, and his line under the
    // square is for the answers nobody saw (AC25).
    setWindowOpen(open: boolean): void {
        if (this.windowOpen === open) {
            return;
        }
        this.windowOpen = open;
        this.setWindowTimer(open);
        this.tellWindow();
    }

    private setWindowTimer(on: boolean): void {
        this.windowTimer?.();
        this.windowTimer = null;
        if (on) {
            this.windowTimer = TabActivity.getInstance().every(
                whileShown(WindowRenewMs),
                () => this.tellWindow(),
                "brokk-talk-window"
            );
        }
    }

    private tellWindow(): void {
        void this.op({ op: "window", origin: this.origin(), open: this.windowOpen && this.visible() });
    }

    // Gives the message to his session, starting it when it does not exist; wavesrv then follows his answer. Resolves
    // with what came of the message. clearPrompt: the developer chose, with his own click, to empty his prompt (#2257).
    async say(typed: string, opts: { clearPrompt?: boolean } = {}): Promise<TalkState> {
        if (globalStore.get(this.queuedAtom) == null && globalStore.get(this.stateAtom).phase !== "queued") {
            globalStore.set(this.stateAtom, SendingTalk);
        }
        await this.moves;
        const data: Record<string, unknown> = {
            text: typed,
            workspaceid: globalStore.get(atoms.workspace)?.oid ?? "",
            name: globalStore.get(BossBubbleModel.getInstance().nameAtom),
            origin: this.origin(),
        };
        if (opts.clearPrompt === true) {
            data.clearprompt = true;
        }
        let state: TalkState;
        try {
            state = talkStateOfWire(await this.call(TalkSayCommand, data, SayTimeoutMs));
        } catch (e) {
            console.log("brokk session: the message did not go", e);
            state = talkStateOfWire(null);
            globalStore.set(this.stateAtom, state);
        }
        void this.refresh();
        return state;
    }

    // The developer's Cancel on the waiting message of the conversation on screen (#2284): it does not go, and its text
    // goes back to the field.
    cancelQueued(): void {
        void this.op({ op: "cancel" });
    }

    // A field takes the text a cancel or a failure gave back to the conversation on screen.
    takeReturned(): Promise<string> {
        globalStore.set(this.returnedAtom, null);
        return this.op({ op: "take" });
    }

    // The developer's answer to the request on screen, for that request alone: its id and his terminal's block.
    async permit(ask: PermissionAsk, decision: PermitDecision): Promise<PermitStatus> {
        return this.answerAsk(ask, { decision });
    }

    // The developer's answers to his agent's question (AC100), by the question's text.
    async answer(ask: PermissionAsk, answers: Record<string, string>): Promise<PermitStatus> {
        return this.answerAsk(ask, { decision: "answer", answers });
    }

    private async answerAsk(ask: PermissionAsk, data: Record<string, unknown>): Promise<PermitStatus> {
        let status: PermitStatus = "gone";
        try {
            const result = await this.call(PermitCommand, { id: ask.id, blockid: ask.blockid, ...data }, FindTimeoutMs);
            status = result?.status ?? "gone";
        } catch (e) {
            console.log("brokk session: the answer to his agent's request did not go", e);
        }
        // Answered here or over: the card goes. An answer that was not valid leaves the request waiting. Whether it was
        // over elsewhere is the talk's to say, in every window (a click just after another window's answer is no news).
        if (status !== "invalid" && globalStore.get(this.permissionAtom)?.id === ask.id) {
            globalStore.set(this.permissionAtom, null);
        }
        await this.refresh();
        return status;
    }

    // The developer writes again: the note of a failed message goes (wavesrv keeps an answer still coming, and a message
    // waiting for him, #2284).
    clearNote(): void {
        if (this.clearing) {
            return;
        }
        this.clearing = true;
        void this.op({ op: "clearnote" }).finally(() => {
            this.clearing = false;
        });
    }
}
