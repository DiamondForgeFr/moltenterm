// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merge queue's side of wavesrv (FR-REV-025, FR-REV-026): the queue of each project and base, asked when a Reviews
// list or a Validate sheet shows and kept up to date by its event, so a reload of the window shows it where it is.
// Joining, withdrawing and cancelling are the developer's clicks in this window only.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { t } from "../i18n/i18n";
import { ReviewMergePlan, ReviewPrInfo, ReviewRoute } from "../review/review-client";
import {
    BatchCancelCommand,
    BatchDismissCommand,
    BatchEvent,
    BatchGetCommand,
    BatchRun,
    QueueAddCommand,
    QueueAddRequest,
    queueOrder,
    QueueWithdrawCommand,
} from "./reviews-batch-model";
import { ReviewsAnswers } from "./reviews-client";
import { ForecastAnswers } from "./reviews-forecast-client";
import { ReviewsMerges } from "./reviews-merges";

const BatchRpcTimeoutMs = 15000;

// queueKey: one queue per project and base.
export function queueKey(dir: string, base: string): string {
    return `${dir}\n${base ?? ""}`;
}

// noteBatchMerges: each PR the queue merged leaves the list to review as its step ends (#898), and one it found merged
// away too, without waiting for GitHub to be read again.
export function noteBatchMerges(run: BatchRun) {
    if (run?.dir == null) {
        return;
    }
    const merges = ReviewsMerges.getInstance();
    for (const item of run.items ?? []) {
        const merged = item.state === "merged";
        if (!merged && !(item.state === "skipped" && item.reason === "mergedaway")) {
            continue;
        }
        merges.note(run.dir, {
            number: item.number,
            mergedat: merged ? item.endedat || undefined : undefined,
            base: run.base,
            title: item.title,
            url: item.url,
            branch: item.headref,
            ticket: item.ticket,
            byyou: merged,
            byqueue: merged ? (item.source === "batch" ? "group" : "queue") : undefined,
        });
    }
}

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

    store(dir: string, base: string, run: BatchRun) {
        if (!dir) {
            return;
        }
        const key = queueKey(dir, base);
        const runs = globalStore.get(this.runsAtom);
        if (run == null && runs[key] == null) {
            return;
        }
        globalStore.set(this.runsAtom, { ...runs, [key]: run });
        noteBatchMerges(run);
    }

    runOf(dir: string, base: string): BatchRun {
        return globalStore.get(this.runsAtom)[queueKey(dir, base)] ?? null;
    }

    private async call(
        command: string,
        data: { dir: string; base: string; [key: string]: unknown }
    ): Promise<BatchRun> {
        const run: BatchRun = await TabRpcClient.wshRpcCall(command, data, {
            route: ReviewRoute,
            timeout: BatchRpcTimeoutMs,
        });
        if (data?.dir) {
            this.store(data.dir, data.base, run ?? null);
        }
        return run;
    }

    get(dir: string, base: string): Promise<BatchRun> {
        return this.call(BatchGetCommand, { dir, base });
    }

    add(req: QueueAddRequest): Promise<BatchRun> {
        return this.call(QueueAddCommand, req);
    }

    withdraw(run: BatchRun, number: number): Promise<BatchRun> {
        return this.call(QueueWithdrawCommand, { dir: run.dir, base: run.base, number });
    }

    cancel(run: BatchRun): Promise<BatchRun> {
        return this.call(BatchCancelCommand, { dir: run.dir, base: run.base, id: run.id });
    }

    dismiss(run: BatchRun): Promise<BatchRun> {
        return this.call(BatchDismissCommand, { dir: run.dir, base: run.base, id: run.id });
    }

    // follow reads the project's queue for the base once and follows its event; it returns the unsubscribe.
    follow(dir: string, base: string): () => void {
        this.get(dir, base).catch((e) => console.log("reviews: merge queue", e));
        return waveEventSubscribeSingle({
            eventType: BatchEvent as WaveEventName,
            scope: dir,
            handler: (event) => {
                const next = event.data as BatchRun;
                if (next?.dir === dir && next?.base === base) {
                    this.store(dir, base, next);
                }
            },
        });
    }
}

// queueValidated: Validate on a PR whose only wait is the CI (FR-REV-026 AC1) puts it in the project's queue for its
// base, bound to the plan the developer validated; the suggested order comes from the Reviews list's last answer and
// forecast when they are about that base.
export function queueValidated(
    pr: ReviewPrInfo,
    plan: ReviewMergePlan,
    override: boolean,
    method: string,
    workspaceid: string
): Promise<BatchRun> {
    const base = plan.baseref || pr.baseref;
    const model = BatchRuns.getInstance();
    const answer = globalStore.get(ReviewsAnswers.getInstance().answersAtom)[pr.dir];
    const forecast = globalStore.get(ForecastAnswers.getInstance().answersAtom)[pr.dir];
    const listed = answer?.target === base ? [...(answer.ready ?? []), ...(answer.drafts ?? [])] : [];
    const order = queueOrder(forecast, listed, model.runOf(pr.dir, base), [pr.number]);
    return model.add({
        dir: pr.dir,
        repo: pr.repo,
        base,
        prs: [
            {
                number: pr.number,
                headref: plan.headref || pr.headref,
                headoid: plan.headoid,
                title: pr.title,
                url: pr.url,
                ticket: plan.ticket || pr.ticket,
                planid: plan.id,
                method,
                override,
            },
        ],
        source: "validate",
        order,
        workspaceid,
        tabname: t("reviews.batch.tabName"),
    });
}

// useBatchRun reads the project's queue for the base once and follows its event.
export function useBatchRun(dir: string, base: string): BatchRun {
    const runs = useAtomValue(BatchRuns.getInstance().runsAtom);
    useEffect(() => {
        if (!dir || !base) {
            return;
        }
        return BatchRuns.getInstance().follow(dir, base);
    }, [dir, base]);
    return dir && base ? (runs[queueKey(dir, base)] ?? null) : null;
}
