// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's side of wavesrv (FR-REV-001, NFR-REV-002): it asks while it is shown and adds no poller. Mission
// Control's frame already asks the collector every 15 s while the view shows (whileShown); the review list is asked
// again when that snapshot changes, when the window gets the focus, on the reports event, and after a review action.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useCallback, useEffect, useState } from "react";
import { MissionRouteId } from "../mission/mission-client";
import { MissionSnapshot } from "../mission/mission-model";
import { ReviewsAnswer } from "./reviews-model";

// must match the names in pkg/molten/mission/reviews.go
export const ReviewsCommand = "moltenmissionreviews";
export const ReviewsEvent = "molten:mission:reviews";

const ReviewsRpcTimeoutMs = 15000;

export function reviewsGet(dir: string, force?: boolean): Promise<ReviewsAnswer> {
    return TabRpcClient.wshRpcCall(
        ReviewsCommand,
        { dir, force: force || undefined },
        { route: MissionRouteId, timeout: ReviewsRpcTimeoutMs }
    );
}

export type ReviewsState = {
    answer: ReviewsAnswer;
    error: string;
    // Forced: the collector reads GitHub again (at most every 10 s) and the reports with it; what a review action
    // (publish, merge, restart work) calls once it is done.
    refresh: () => void;
};

export function useReviews(dir: string, snapshot: MissionSnapshot): ReviewsState {
    const [answer, setAnswer] = useState<ReviewsAnswer>(null);
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
                        setAnswer(next);
                        setError(null);
                    }
                } catch (e) {
                    setError(String(e?.message ?? e));
                }
            });
        },
        [dir]
    );
    useEffect(() => {
        setAnswer(null);
        setError(null);
        if (!dir) {
            return;
        }
        const unsubscribe = waveEventSubscribeSingle({
            eventType: ReviewsEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const next = event.data as ReviewsAnswer;
                if (next?.dir === dir) {
                    setAnswer(next);
                }
            },
        });
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
    return { answer, error, refresh };
}
