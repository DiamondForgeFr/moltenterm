// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The upcoming work's side of wavesrv (#712): asked while the Reviews view shows, each time its review list changes
// (the collector's 15 s ask while shown, a refresh, a review action) and when the window gets the focus. No timer of
// its own: wavesrv caches the answer 20 s, so these asks cost a git read at most that often.

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import type { AgentStatesData } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { MissionRouteId } from "../mission/mission-client";
import type { ReviewsAnswer } from "./reviews-model";
import { UpcomingAnswer, UpcomingCommand } from "./reviews-upcoming-model";

const UpcomingRpcTimeoutMs = 30000;

export class UpcomingAnswers {
    private static instance: UpcomingAnswers = null;

    answersAtom = atom({}) as PrimitiveAtom<Record<string, UpcomingAnswer>>;

    private constructor() {}

    static getInstance(): UpcomingAnswers {
        if (UpcomingAnswers.instance == null) {
            UpcomingAnswers.instance = new UpcomingAnswers();
        }
        return UpcomingAnswers.instance;
    }

    static resetInstance(): void {
        UpcomingAnswers.instance = null;
    }

    store(answer: UpcomingAnswer) {
        if (!answer?.dir) {
            return;
        }
        const answers = globalStore.get(this.answersAtom);
        if (answers[answer.dir]?.at === answer.at) {
            return;
        }
        globalStore.set(this.answersAtom, { ...answers, [answer.dir]: answer });
    }
}

export async function upcomingGet(dir: string, force?: boolean): Promise<UpcomingAnswer> {
    const answer: UpcomingAnswer = await TabRpcClient.wshRpcCall(
        UpcomingCommand,
        { dir, force: force || undefined },
        { route: MissionRouteId, timeout: UpcomingRpcTimeoutMs }
    );
    if (answer?.dir === dir) {
        UpcomingAnswers.getInstance().store(answer);
    }
    return answer;
}

// What makes the upcoming work worth asking again: GitHub read again, or the PRs listed changed.
export function upcomingAskKey(reviews: ReviewsAnswer): string {
    if (reviews == null) {
        return "";
    }
    const branches = [...(reviews.ready ?? []), ...(reviews.drafts ?? [])].map((pr) => pr.branch).sort();
    return `${reviews.githubat ?? 0}|${reviews.refreshing ? 1 : 0}|${branches.join(",")}`;
}

export function useUpcomingAnswer(dir: string): UpcomingAnswer {
    const answers = useAtomValue(UpcomingAnswers.getInstance().answersAtom);
    return dir ? answers[dir] : null;
}

// The agent runs the windows know: one starting, restored by a restart (#1077) or closing places agents on branches
// anew. Their states (working, waiting) are not part of it: the bars read those live, without asking wavesrv.
export function agentsAskKey(data: AgentStatesData): string {
    return Object.values(data?.states ?? {})
        .map((info) => `${info.blockid}@${info.started ?? 0}`)
        .sort()
        .join(",");
}

// upcomingAskForce: whether an ask skips wavesrv's cache. Seen: the agents of the last ask, null before the first one
// (wavesrv's answer is then as fresh as the agents it saw).
export function upcomingAskForce(seen: string, agents: string): boolean {
    return seen != null && seen !== agents;
}

// Asks while the Reviews list of the project shows; the answer lands in the per-project store the bars read.
export function useUpcomingWatch(dir: string, reviews: ReviewsAnswer) {
    const key = upcomingAskKey(reviews);
    const agents = agentsAskKey(useAtomValue(AgentStates.getInstance().dataAtom));
    const lastAgents = useRef<string>(null);
    useEffect(() => {
        if (!dir || !key) {
            return;
        }
        // An agent started, came back after a restart or closed since the last ask: wavesrv's placement is out of
        // date, and wavesrv recomputes it whatever its cache's age (pkg/molten/mission/upcoming.go).
        const force = upcomingAskForce(lastAgents.current, agents);
        lastAgents.current = agents;
        fireAndForget(async () => {
            try {
                await upcomingGet(dir, force);
            } catch (e) {
                console.log("reviews: upcoming work", e);
            }
        });
    }, [dir, key, agents]);
    useEffect(() => {
        if (!dir) {
            return;
        }
        const onFocus = () => {
            upcomingGet(dir).catch(() => {});
        };
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [dir]);
}
