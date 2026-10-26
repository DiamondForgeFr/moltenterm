// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The requests to a leftover's live owner (#1143), as wavesrv follows them (pkg/molten/review/leftover_ask.go): asked
// when a Reviews list shows and kept up to date by their event. Asking is the developer's Clean up in this window only.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { ReviewRoute } from "../review/review-client";
import {
    LeftoverAsk,
    LeftoverAskCommand,
    LeftoverAskEvent,
    LeftoverAskRequest,
    LeftoverAsksAnswer,
    LeftoverAsksCommand,
} from "./reviews-leftover-owner-model";
import { upcomingGet } from "./reviews-upcoming-client";

// wavesrv reads git and may type into the owner's terminal: the answer is awaited a little longer than its own limit.
const AskRpcTimeoutMs = 95000;
const ListRpcTimeoutMs = 15000;
// A forced ask wavesrv answers from its cache for this long (pkg/molten/mission/upcoming.go upcomingForcedInterval).
const UpcomingForcedIntervalMs = 5500;

export class LeftoverAsks {
    private static instance: LeftoverAsks = null;

    asksAtom = atom({}) as PrimitiveAtom<Record<string, LeftoverAsksAnswer>>;
    // The requests a Clean up of this window made: once one is done, the rest of that leftover's cleanup runs.
    continuesAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;
    follows: Record<string, { count: number; stop: () => void }> = {};

    private constructor() {}

    static getInstance(): LeftoverAsks {
        if (LeftoverAsks.instance == null) {
            LeftoverAsks.instance = new LeftoverAsks();
        }
        return LeftoverAsks.instance;
    }

    static resetInstance(): void {
        LeftoverAsks.instance = null;
    }

    store(answer: LeftoverAsksAnswer) {
        if (!answer?.dir) {
            return;
        }
        const before = globalStore.get(this.asksAtom)[answer.dir];
        globalStore.set(this.asksAtom, (all) => ({ ...all, [answer.dir]: answer }));
        const wasDone = new Set((before?.asks ?? []).filter((a) => a.state === "done").map((a) => a.worktree));
        if ((answer.asks ?? []).some((a) => a.state === "done" && !wasDone.has(a.worktree))) {
            refreshUpcoming(answer.dir);
        }
    }

    async list(dir: string): Promise<LeftoverAsksAnswer> {
        const answer: LeftoverAsksAnswer = await TabRpcClient.wshRpcCall(
            LeftoverAsksCommand,
            { dir },
            { route: ReviewRoute, timeout: ListRpcTimeoutMs }
        );
        this.store(answer);
        return answer;
    }

    // ask: the developer's Clean up on a leftover whose owner runs; wavesrv checks the lock again and asks the owner.
    async ask(req: LeftoverAskRequest): Promise<LeftoverAsk> {
        const ask: LeftoverAsk = await TabRpcClient.wshRpcCall(LeftoverAskCommand, req, {
            route: ReviewRoute,
            timeout: AskRpcTimeoutMs,
        });
        if (ask?.state === "asked" || ask?.state === "needsyou") {
            globalStore.set(this.continuesAtom, (all) => ({ ...all, [continueKey(req.dir, req.number)]: true }));
        }
        this.list(req.dir).catch(() => {});
        return ask;
    }

    takeContinue(dir: string, pr: number): boolean {
        const key = continueKey(dir, pr);
        if (!globalStore.get(this.continuesAtom)[key]) {
            return false;
        }
        globalStore.set(this.continuesAtom, (all) => {
            const next = { ...all };
            delete next[key];
            return next;
        });
        return true;
    }

    // follow reads the project's requests once and follows their event while a Reviews list of it shows.
    follow(dir: string): () => void {
        const have = this.follows[dir];
        if (have != null) {
            have.count++;
            return () => this.unfollow(dir);
        }
        this.list(dir).catch((e) => console.log("reviews: leftover requests", e));
        const stop = waveEventSubscribeSingle({
            eventType: LeftoverAskEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const next = event.data as LeftoverAsksAnswer;
                if (next?.dir === dir) {
                    this.store(next);
                }
            },
        });
        this.follows[dir] = { count: 1, stop };
        return () => this.unfollow(dir);
    }

    unfollow(dir: string) {
        const have = this.follows[dir];
        if (have == null) {
            return;
        }
        have.count--;
        if (have.count > 0) {
            return;
        }
        have.stop();
        delete this.follows[dir];
    }
}

// refreshUpcoming: the worktree went, wavesrv's upcoming answer is read again now and after its forced-ask cache.
function refreshUpcoming(dir: string) {
    upcomingGet(dir, true).catch(() => {});
    setTimeout(() => upcomingGet(dir, true).catch(() => {}), UpcomingForcedIntervalMs);
}

export function continueKey(dir: string, pr: number): string {
    return `${dir}#${pr}`;
}

export function useLeftoverAsks(dir: string): LeftoverAsksAnswer {
    const all = useAtomValue(LeftoverAsks.getInstance().asksAtom);
    useEffect(() => {
        if (!dir) {
            return;
        }
        return LeftoverAsks.getInstance().follow(dir);
    }, [dir]);
    return dir ? (all[dir] ?? null) : null;
}
