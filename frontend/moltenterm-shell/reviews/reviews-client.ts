// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's side of wavesrv (FR-REV-001, NFR-REV-002): it asks while it is shown and adds no poller. Mission
// Control's frame already asks the collector every 15 s while the view shows (whileShown); the review list is asked
// again when that snapshot changes, when the window gets the focus, on the reports event, and after a review action.
// Every answer lands in one store per project (#688), which the rail's Reviews counts read too: the rail asks
// passively (wavesrv reads GitHub every 2 min, only for a GitHub project whose gh works), the view keeps it fresher.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { serverErrorText } from "../i18n/server-text";
import { MissionRouteId, MissionUpdateEvent } from "../mission/mission-client";
import { MissionSnapshot } from "../mission/mission-model";
import { TabActivity, whileShown } from "../tab-activity";
import { ReviewsAnswer } from "./reviews-model";

// must match the names in pkg/molten/mission/reviews.go
export const ReviewsCommand = "moltenmissionreviews";
export const ReviewsEvent = "molten:mission:reviews";

const ReviewsRpcTimeoutMs = 15000;
// The rail's ask while the window shows; wavesrv decides whether GitHub is due (railGithubInterval).
const RailPollMs = 60000;

// The latest review answer of each project, whoever asked.
export class ReviewsAnswers {
    private static instance: ReviewsAnswers = null;

    answersAtom = atom({}) as PrimitiveAtom<Record<string, ReviewsAnswer>>;

    private constructor() {}

    static getInstance(): ReviewsAnswers {
        if (ReviewsAnswers.instance == null) {
            ReviewsAnswers.instance = new ReviewsAnswers();
        }
        return ReviewsAnswers.instance;
    }

    static resetInstance(): void {
        ReviewsAnswers.instance = null;
    }

    store(answer: ReviewsAnswer) {
        if (!answer?.dir) {
            return;
        }
        const answers = globalStore.get(this.answersAtom);
        if (answers[answer.dir] === answer) {
            return;
        }
        globalStore.set(this.answersAtom, { ...answers, [answer.dir]: answer });
    }
}

// passive: the rail's counts (#688); wavesrv never starts the reports query for it.
export async function reviewsGet(dir: string, force?: boolean, passive?: boolean): Promise<ReviewsAnswer> {
    const answer: ReviewsAnswer = await TabRpcClient.wshRpcCall(
        ReviewsCommand,
        { dir, force: force || undefined, passive: passive || undefined },
        { route: MissionRouteId, timeout: ReviewsRpcTimeoutMs }
    );
    if (answer?.dir === dir) {
        ReviewsAnswers.getInstance().store(answer);
    }
    return answer;
}

function subscribeReviewsEvent(dir: string): () => void {
    return waveEventSubscribeSingle({
        eventType: ReviewsEvent as WaveEventName,
        scope: dir,
        handler: (event) => {
            const next = event.data as ReviewsAnswer;
            if (next?.dir === dir) {
                ReviewsAnswers.getInstance().store(next);
            }
        },
    });
}

export function useReviewsAnswer(dir: string): ReviewsAnswer {
    const answers = useAtomValue(ReviewsAnswers.getInstance().answersAtom);
    return dir ? answers[dir] : null;
}

export type ReviewsState = {
    answer: ReviewsAnswer;
    error: string;
    // Forced: the collector reads GitHub again (at most every 10 s) and the reports with it; what a review action
    // (publish, merge, restart work) calls once it is done.
    refresh: () => void;
};

export function useReviews(dir: string, snapshot: MissionSnapshot): ReviewsState {
    const stored = useReviewsAnswer(dir);
    // The view shows only what it asked since it opened on this project: the rail's earlier answer may lack the
    // reports a view's ask brings.
    const [asked, setAsked] = useState<string>(null);
    const [error, setError] = useState<string>(null);
    const ask = useCallback(
        (force: boolean) => {
            if (!dir) {
                return;
            }
            fireAndForget(async () => {
                try {
                    const next = await reviewsGet(dir, force);
                    if (next?.dir === dir) {
                        setAsked(dir);
                        setError(null);
                    }
                } catch (e) {
                    setError(serverErrorText(e));
                }
            });
        },
        [dir]
    );
    useEffect(() => {
        setAsked(null);
        setError(null);
        if (!dir) {
            return;
        }
        const unsubscribe = subscribeReviewsEvent(dir);
        const onFocus = () => ask(false);
        window.addEventListener("focus", onFocus);
        return () => {
            unsubscribe();
            window.removeEventListener("focus", onFocus);
        };
    }, [dir, ask]);
    // The frame's snapshot changed (a collector refresh, or its 15 s ask while shown): the list follows it.
    const githubAt = snapshot?.githubat ?? 0;
    const refreshing = snapshot?.refreshing ?? false;
    useEffect(() => {
        ask(false);
    }, [ask, githubAt, refreshing]);
    const refresh = useCallback(() => ask(true), [ask]);
    const answer = useMemo(() => (asked === dir ? stored : null), [asked, dir, stored]);
    return { answer, error, refresh };
}

// The rail's Reviews counts (#688) for the window's active project: a passive ask now, every RailPollMs while the
// window shows, on the window's focus, and when the collector or the reports move.
export function useReviewsRailWatch(dir: string) {
    useEffect(() => {
        if (!dir) {
            return;
        }
        const ask = () => {
            reviewsGet(dir, false, true).catch(() => {});
        };
        const unsubscribeReviews = subscribeReviewsEvent(dir);
        // A git read that just named a GitHub origin makes GitHub due: ask again at once.
        const unsubscribeMission = waveEventSubscribeSingle({
            eventType: MissionUpdateEvent as WaveEventName,
            scope: dir,
            handler: ask,
        });
        window.addEventListener("focus", ask);
        ask();
        const stop = TabActivity.getInstance().every(whileShown(RailPollMs), ask, "reviews-rail");
        return () => {
            unsubscribeReviews();
            unsubscribeMission();
            window.removeEventListener("focus", ask);
            stop();
        };
    }, [dir]);
}
