// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A failed CI on a Reviews row (#797): Rerun failed jobs, from the card's "…" menu (#1060), asks for a confirmation in
// the card, then wavesrv reruns them and a notification tells the outcome. Analyze and resolve is the card's own
// primary action (reviews-card-model.ts). Nothing runs before the developer's click.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { useEscape } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { phrase, Phrase, useWordPhrase } from "../i18n/phrase";
import { MoltenWave } from "../molten-button";
import { checkNames, checksOf, ReviewPr } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";

export type RerunPhase = "idle" | "confirm" | "sending" | "started" | "failed";

export type RerunState = {
    phase: RerunPhase;
    text: string;
    ask: () => void;
    confirm: () => void;
    cancel: () => void;
};

// rerunnable: a failed check GitHub Actions ran, whose run can be started again.
export function rerunnable(pr: ReviewPr): boolean {
    return checksOf(pr.ci, "failure").some((c) => (c.runid ?? 0) > 0);
}

export function useRerunFailed(dir: string, number: number): RerunState {
    const word = useWordPhrase();
    const [phase, setPhase] = useState<RerunPhase>("idle");
    const [text, setText] = useState<Phrase>(null);
    const cancel = () => {
        setPhase("idle");
        setText(null);
    };
    useEscape(phase === "confirm" || phase === "failed" || phase === "started", cancel);
    return {
        phase,
        text: word(text),
        ask: () => {
            setText(null);
            setPhase("confirm");
        },
        confirm: () => {
            if (phase === "sending") {
                return;
            }
            setPhase("sending");
            fireAndForget(async () => {
                const { error, checks } = await ReviewsModel.getInstance().rerunFailed(dir, number);
                if (error) {
                    setText(error);
                    setPhase("failed");
                    return;
                }
                setText(phrase("reviews.ci.rerun.started", { names: checks.join(", ") }));
                setPhase("started");
            });
        },
        cancel,
    };
}

function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

// The confirmation in the row, then what happened: the rerun started (the notification follows) or why it did not.
export function RerunConfirm({ pr, state }: { pr: ReviewPr; state: RerunState }) {
    const t = useT();
    if (state.phase === "idle") {
        return null;
    }
    const failed = state.phase === "failed";
    const asking = state.phase === "confirm" || state.phase === "sending";
    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-2 text-12 leading-4",
                failed ? "text-danger" : "text-secondary"
            )}
            role={failed ? "alert" : "status"}
            onClick={stop}
            onKeyDown={stop}
            data-testid="reviews-rerun-confirm"
        >
            <span className="min-w-0 flex-1">
                {asking ? t("reviews.ci.rerun.confirm", { names: checkNames(checksOf(pr.ci, "failure")) }) : state.text}
            </span>
            {asking ? (
                <button
                    type="button"
                    onClick={state.confirm}
                    aria-busy={state.phase === "sending" || undefined}
                    className="molten-btn flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-1 text-12"
                    data-testid="reviews-rerun-yes"
                >
                    {state.phase === "sending" ? t("reviews.ci.rerun.sending") : t("reviews.ci.rerun.confirmButton")}
                    <MoltenWave />
                </button>
            ) : null}
            <button
                type="button"
                onClick={state.cancel}
                className="flex shrink-0 cursor-pointer items-center rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                data-testid="reviews-rerun-dismiss"
            >
                {asking ? t("common.cancel") : t("reviews.ready.dismiss")}
            </button>
        </div>
    );
}
