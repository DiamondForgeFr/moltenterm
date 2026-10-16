// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The conflict forecast's side of wavesrv (FR-REV-023, NFR-REV-010): asked while the Reviews list shows, each time the
// PRs or the base it lists move, and on its refresh. wavesrv answers at once with the last forecast and computes in
// the background; the result comes as a ForecastEvent into one store per project, which the list reads (and the
// suggested merge order, #781, after it).

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { ReviewRoute } from "../review/review-client";
import { Forecast, ForecastCommand, ForecastEvent, forecastKey, ForecastRequest } from "./reviews-forecast-model";

const ForecastRpcTimeoutMs = 15000;

export class ForecastAnswers {
    private static instance: ForecastAnswers = null;

    answersAtom = atom({}) as PrimitiveAtom<Record<string, Forecast>>;

    private constructor() {}

    static getInstance(): ForecastAnswers {
        if (ForecastAnswers.instance == null) {
            ForecastAnswers.instance = new ForecastAnswers();
        }
        return ForecastAnswers.instance;
    }

    static resetInstance(): void {
        ForecastAnswers.instance = null;
    }

    store(answer: Forecast) {
        if (!answer?.dir) {
            return;
        }
        const answers = globalStore.get(this.answersAtom);
        const current = answers[answer.dir];
        if (
            current != null &&
            current.key === answer.key &&
            current.at === answer.at &&
            current.running === answer.running &&
            current.stale === answer.stale
        ) {
            return;
        }
        globalStore.set(this.answersAtom, { ...answers, [answer.dir]: answer });
    }
}

export async function forecastGet(req: ForecastRequest): Promise<Forecast> {
    const answer: Forecast = await TabRpcClient.wshRpcCall(ForecastCommand, req, {
        route: ReviewRoute,
        timeout: ForecastRpcTimeoutMs,
    });
    if (answer?.dir === req.dir) {
        ForecastAnswers.getInstance().store(answer);
    }
    return answer;
}

export function useForecastAnswer(dir: string): Forecast {
    const answers = useAtomValue(ForecastAnswers.getInstance().answersAtom);
    return dir ? answers[dir] : null;
}

// useForecastWatch asks for the list's request whenever it changes (a push, a merge, a base move) and listens to the
// project's forecasts. The request is read through its key: a new object with the same PRs asks nothing.
export function useForecastWatch(dir: string, req: ForecastRequest) {
    const key = forecastKey(req);
    useEffect(() => {
        if (!dir) {
            return;
        }
        return waveEventSubscribeSingle({
            eventType: ForecastEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const next = event.data as Forecast;
                if (next?.dir === dir) {
                    ForecastAnswers.getInstance().store(next);
                }
            },
        });
    }, [dir]);
    useEffect(() => {
        if (!dir || req == null || req.dir !== dir) {
            return;
        }
        const ask = () => {
            forecastGet(req).catch((e) => console.log("reviews: forecast", e));
        };
        ask();
        // wavesrv answers from its cache; a failed forecast is tried again there, at most once a minute.
        window.addEventListener("focus", ask);
        return () => window.removeEventListener("focus", ask);
    }, [dir, key]);
}
