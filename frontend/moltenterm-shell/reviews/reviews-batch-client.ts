// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The batch merge's side of wavesrv (FR-REV-025): the run of each project, asked when a Reviews list shows and kept up
// to date by its event, so a reload of the window shows the run where it is. Starting, deciding and cancelling are the
// developer's clicks in this window only.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { ReviewRoute } from "../review/review-client";
import {
    BatchCancelCommand,
    BatchDecideCommand,
    BatchDecision,
    BatchDismissCommand,
    BatchEvent,
    BatchGetCommand,
    BatchRun,
    BatchStartCommand,
    BatchStartRequest,
} from "./reviews-batch-model";

const BatchRpcTimeoutMs = 15000;

export class BatchRuns {
    private static instance: BatchRuns = null;

    runsAtom = atom({}) as PrimitiveAtom<Record<string, BatchRun>>;

    private constructor() {}

    static getInstance(): BatchRuns {
        if (BatchRuns.instance == null) {
            BatchRuns.instance = new BatchRuns();
        }
        return BatchRuns.instance;
    }

    static resetInstance(): void {
        BatchRuns.instance = null;
    }

    store(dir: string, run: BatchRun) {
        if (!dir) {
            return;
        }
        const runs = globalStore.get(this.runsAtom);
        if (run == null && runs[dir] == null) {
            return;
        }
        globalStore.set(this.runsAtom, { ...runs, [dir]: run });
    }

    private async call(command: string, data: any): Promise<BatchRun> {
        const run: BatchRun = await TabRpcClient.wshRpcCall(command, data, {
            route: ReviewRoute,
            timeout: BatchRpcTimeoutMs,
        });
        if (data?.dir) {
            this.store(data.dir, run ?? null);
        }
        return run;
    }

    get(dir: string): Promise<BatchRun> {
        return this.call(BatchGetCommand, { dir });
    }

    start(req: BatchStartRequest): Promise<BatchRun> {
        return this.call(BatchStartCommand, req);
    }

    cancel(run: BatchRun): Promise<BatchRun> {
        return this.call(BatchCancelCommand, { dir: run.dir, id: run.id });
    }

    async decide(run: BatchRun, decision: BatchDecision): Promise<void> {
        await TabRpcClient.wshRpcCall(
            BatchDecideCommand,
            { dir: run.dir, id: run.id, decision },
            { route: ReviewRoute, timeout: BatchRpcTimeoutMs }
        );
    }

    dismiss(run: BatchRun): Promise<BatchRun> {
        return this.call(BatchDismissCommand, { dir: run.dir, id: run.id });
    }
}

// useBatchRun reads the project's run once and follows its event.
export function useBatchRun(dir: string): BatchRun {
    const runs = useAtomValue(BatchRuns.getInstance().runsAtom);
    useEffect(() => {
        if (!dir) {
            return;
        }
        const model = BatchRuns.getInstance();
        model.get(dir).catch((e) => console.log("reviews: batch", e));
        return waveEventSubscribeSingle({
            eventType: BatchEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const next = event.data as BatchRun;
                if (next?.dir === dir) {
                    model.store(dir, next);
                }
            },
        });
    }, [dir]);
    return dir ? runs[dir] : null;
}
