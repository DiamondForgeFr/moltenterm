// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk's visit words (FR-BOSS-009, AC82, #2222): it draws the phrasing a visit says (the rules are
// brokk-visit-wording.ts's), keeps it while that visit is up, and saves what was said last so that the same sentence does
// not come back within a few visits, after a restart or in another window.
//
// It is loaded with the visit scene, never with the window: the scene is Brokk's portrait.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import {
    decodeWording,
    drawWording,
    encodeWording,
    rememberWording,
    VisitPhrasings,
    VisitReason,
    WordingMemory,
    WordingPick,
} from "./brokk-visit-wording";

// Like the kind colleague's memory, what outlives a run lives in the client's meta, one text: the pages' localStorage is
// gone at every restart (#1763), and the meta is shared by every window at once.
export const WordsMetaKey = "moltenterm:brokkvisitwords";
// A write whose echo has not come back after this long is dropped, so that a failed write cannot hide the other windows'.
export const WriteEchoMs = 30000;

export type VisitWordsDeps = {
    now: () => number;
    random: () => number;
    // The text kept across restarts, null when there is none; and its writing.
    read: () => string;
    write: (text: string) => void;
};

function liveRead(): string {
    const clientAtom = ClientModel.getInstance().clientAtom;
    const value = (clientAtom != null ? globalStore.get(clientAtom) : null)?.meta?.[WordsMetaKey];
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
            meta: { [WordsMetaKey]: text } as MetaType,
        })
    );
}

const LiveDeps: VisitWordsDeps = {
    now: () => Date.now(),
    random: () => Math.random(),
    read: liveRead,
    write: liveWrite,
};

export class BrokkVisitWords {
    private static instance: BrokkVisitWords = null;

    private deps: VisitWordsDeps = LiveDeps;
    private memory: WordingMemory = {};
    private loaded = false;
    private saved = "";
    // What this window wrote and the meta has not echoed yet.
    private pending: { text: string; at: number } = null;
    // The sentence of the visit that is up: asked again while it renders, it stays the same.
    private episode: { signature: string; index: number } = null;

    private constructor() {}

    static getInstance(): BrokkVisitWords {
        if (BrokkVisitWords.instance == null) {
            BrokkVisitWords.instance = new BrokkVisitWords();
        }
        return BrokkVisitWords.instance;
    }

    static resetInstance(): void {
        BrokkVisitWords.instance = null;
    }

    // Tests give a clock, a random source and a meta of their own.
    useDeps(deps: Partial<VisitWordsDeps>): void {
        this.deps = { ...LiveDeps, ...deps };
        this.memory = {};
        this.loaded = false;
        this.saved = "";
        this.pending = null;
        this.episode = null;
    }

    private load(): void {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        try {
            const text = this.deps.read();
            this.memory = text ? decodeWording(text) : {};
        } catch {
            this.memory = {};
        }
        this.saved = encodeWording(this.memory);
    }

    // Another window of this computer shares what was said (one meta): what it saved since is read before a phrasing is
    // drawn. While this window's own write has not come back, the meta is older than the memory and is not read.
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
            this.memory = decodeWording(text);
            this.saved = text;
        } catch {
            // A meta that cannot be read leaves what this window knows.
        }
    }

    private save(): void {
        const text = encodeWording(this.memory);
        if (text === this.saved) {
            return;
        }
        this.saved = text;
        this.pending = { text, at: this.deps.now() };
        try {
            this.deps.write(text);
        } catch {
            // A write that fails only costs a repeated sentence after a restart.
        }
    }

    // The phrasing to say for the sentence of the visit that is up. The first ask for a sentence draws one, outside the
    // last half of the set said for its reason, and remembers it; the next asks for the same sentence get the same one.
    pick: WordingPick = (reason: VisitReason, signature: string): number => {
        if (this.episode?.signature === signature) {
            return this.episode.index;
        }
        this.load();
        this.reload();
        const size = VisitPhrasings[reason];
        const recent = this.memory[reason] ?? [];
        const index = drawWording(size, recent, this.deps.random);
        this.memory = { ...this.memory, [reason]: rememberWording(recent, index, size) };
        this.episode = { signature, index };
        this.save();
        return index;
    };

    // The visit is over: the next one draws its words anew, even for the same event.
    rest(): void {
        this.episode = null;
    }
}
