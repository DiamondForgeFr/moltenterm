// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a tab view carries up front of Brokk's thought in 3D (FR-BOSS-010 AC19, NFR-BOSS-009, #2246): the state the
// layer reads, and a small watch that loads the brainstorm (brainstorm-store.ts and what it needs) only when it is
// needed: the mode is on in some view (wavesrv says so at start, or its event comes), the developer starts one, or his
// answer carries a graph block. A window that never brainstorms loads none of it, and a release channel watches nothing.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { BrokkSession } from "../boss/brokk-session";
import { currentBrainstormAllowed } from "../build/current-build";
import { hasGraphFence } from "./brainstorm-fence";
import type { BrainstormGraph } from "./brainstorm-graph-model";

// must match pkg/molten/brainstorm/route.go
export const BrainstormRouteId = "molten:brainstorm";
export const StateCommand = "moltenbrainstormstate";
export const OpenCommand = "moltenbrainstormopen";
export const CloseCommand = "moltenbrainstormclose";
export const TurnCommand = "moltenbrainstormturn";
// The folders (#2248).
export const ListCommand = "moltenbrainstormlist";
export const FindCommand = "moltenbrainstormfind";
export const LoadCommand = "moltenbrainstormload";
export const NewCommand = "moltenbrainstormnew";
export const RenameCommand = "moltenbrainstormrename";
export const DeleteCommand = "moltenbrainstormdelete";
export const ForkCommand = "moltenbrainstormfork";
// The developer's changes to the graph (#2247).
export const EditCommand = "moltenbrainstormedit";
export const UndoCommand = "moltenbrainstormundo";
export const ToldCommand = "moltenbrainstormtold";
export const BrainstormEvent = "molten:brainstorm";

export const CallTimeoutMs = 8000;

// must match pkg/molten/brainstorm/service.go
export type BrainstormSummary = {
    id?: string;
    slug: string;
    title: string;
    dir: string;
    created: number;
    updated: number;
    state?: string;
    turns: number;
};

export type BrainstormState = {
    allowed: boolean;
    open: boolean;
    by?: "you" | "brokk";
    // The wavesrv that counted version: each one counts from 0.
    session?: string;
    version: number;
    // The brainstorms the developer moved to: the stage starts its camera over on each (#2248).
    swap?: number;
    // The changes of the folders' list: the widget reads it again on each.
    listrev?: number;
    // A forgotten folder goes to the system trash; false: the confirmation says it is removed for good.
    cantrash?: boolean;
    brainstorm?: BrainstormSummary;
    graph?: BrainstormGraph;
    savedat?: number;
    saveerror?: string;
    // The brainstorm's last operations, who made each, and whether each can be put back (#2247).
    history?: HistoryNote[];
};

// must match pkg/molten/brainstorm/history.go
export type NoteNode = { id: string; text?: string; kind?: string };

export type HistoryNote = {
    seq: number;
    at: number;
    by: "you" | "brokk";
    op: string;
    // An undo: the line it put back, and that line's operation.
    ref?: number;
    refop?: string;
    // The nodes the change names: a removed node, a link's two ends, a merge's kept node first.
    nodes?: NoteNode[];
    // What an edit or a retype replaced: the text, the kind.
    was?: string;
    undone?: boolean;
    told?: boolean;
    undoable?: boolean;
};

// The mode as wavesrv last told this view; null before it did (and always on a release channel).
export const BrainstormStateAtom = atom(null) as PrimitiveAtom<BrainstormState>;

// A question his talk window asks the developer about the brainstorms (FR-BOSS-010 AC10a to AC10d, #2248). The window
// answers it with a click, and only then does MoltenTerm act:
// - picker: on entry, the most recent ones to resume, a new idea, or all of them in the widget;
// - duplicate: `/brainstorm <idea>` when one of nearly that title is saved: resume it, or start fresh;
// - resume: his offer to reopen one (Resume, Not now): nothing opens by itself;
// - forget: the developer asked him to forget one: its title and last change, then the confirmation.
export type BrainstormPrompt =
    | { kind: "picker"; recent: BrainstormSummary[]; total: number }
    | { kind: "duplicate"; idea: string; match: BrainstormSummary }
    | { kind: "resume"; match: BrainstormSummary }
    | { kind: "forget"; match: BrainstormSummary };

// The question on screen, null for none. Up front so that his talk window knows when to load what draws it.
export const BrainstormPromptAtom = atom(null) as PrimitiveAtom<BrainstormPrompt>;

// The brainstorm the developer last left (Leave or Escape, FR-BOSS-010 AC10e, #2284): his card and his talk window offer
// to resume it until the developer starts or resumes a brainstorm, or dismisses the offer. Null for none.
export const BrainstormLastLeftAtom = atom(null) as PrimitiveAtom<BrainstormSummary>;

type Brainstorm = typeof import("./brainstorm-store");

let loading: Promise<Brainstorm> = null;
let loaded: Brainstorm = null;

// The brainstorm, loaded once and started: from then on it follows the mode itself.
export function loadBrainstorm(): Promise<Brainstorm> {
    loading ??= import("./brainstorm-store").then((mod) => {
        loaded = mod;
        mod.BrainstormModel.getInstance().start();
        return mod;
    });
    return loading;
}

// The developer switched the brainstorm off (FR-BOSS-011): this view lets go of the mode through its model, which
// releases what the mode held (the pause, the slid sidebar, his card), then forgets its state. Before the model ever
// loaded there is nothing held.
export function forgetBrainstorm(): void {
    if (loaded == null) {
        globalStore.set(BrainstormStateAtom, null);
        return;
    }
    loaded.BrainstormModel.getInstance().forget();
}

// The developer starts a brainstorm (Brokk's menu, the palette, `/brainstorm` in his field). With no idea, his talk
// window offers the saved ones first (#2248). With an idea (#2257) it resolves true when the field sends it now as the
// message whose answer puts it at the centre; false when a brainstorm of nearly that title is saved and he asks first.
export async function openBrainstorm(idea = ""): Promise<boolean> {
    if (!currentBrainstormAllowed()) {
        return false;
    }
    const mod = await loadBrainstorm();
    return mod.BrainstormModel.getInstance().begin(idea);
}

// Resume « title » (AC10e, #2284): the brainstorm last left opens again where it was, its graph, its conversation and
// its camera's overview.
export async function resumeLastBrainstorm(): Promise<boolean> {
    const last = globalStore.get(BrainstormLastLeftAtom);
    if (last == null || !currentBrainstormAllowed()) {
        return false;
    }
    const mod = await loadBrainstorm();
    return mod.BrainstormModel.getInstance().load(last.slug);
}

export function dismissLastBrainstorm(): void {
    globalStore.set(BrainstormLastLeftAtom, null);
}

let booted = false;

// Watches for what needs the brainstorm, in this view. Returns the stop.
export function bootBrainstorm(): () => void {
    if (booted || !currentBrainstormAllowed()) {
        return () => {};
    }
    booted = true;
    const stops: (() => void)[] = [];
    const stop = () => stops.splice(0).forEach((fn) => fn());
    const wake = () => {
        stop();
        // A model loaded before (this view watches again after a switch of Features in test turned the brainstorm off
        // and on) does not read wavesrv's state by itself: the mode may be on already.
        const before = loaded != null;
        return loadBrainstorm().then((mod) => {
            if (before) {
                void mod.BrainstormModel.getInstance().refresh();
            }
            return mod;
        });
    };
    try {
        stops.push(
            waveEventSubscribeSingle({ eventType: BrainstormEvent as WaveEventName, handler: () => void wake() })
        );
    } catch (e) {
        console.log("brainstorm: no event bus", e);
    }
    // His answer with a graph block may open the mode: the brainstorm loads and reads that answer first.
    stops.push(
        BrokkSession.getInstance().listenAnswers((answer) => {
            if (!hasGraphFence(answer.markdown)) {
                return;
            }
            void wake().then((mod) => mod.BrainstormModel.getInstance().onAnswer(answer));
        })
    );
    // The mode is on already (a view opened after it began): the brainstorm loads and takes the screen.
    void readState().then((state) => {
        if (state?.open) {
            void wake();
        }
    });
    // Stopped by the layer (a switch of Features in test turned the brainstorm off, FR-BOSS-011): it can watch again
    // once the switch is back on.
    return () => {
        stop();
        booted = false;
    };
}

async function readState(): Promise<BrainstormState> {
    try {
        return await TabRpcClient.wshRpcCall(StateCommand, {}, { route: BrainstormRouteId, timeout: CallTimeoutMs });
    } catch (e) {
        console.log("brainstorm: wavesrv did not answer", e);
        return null;
    }
}
