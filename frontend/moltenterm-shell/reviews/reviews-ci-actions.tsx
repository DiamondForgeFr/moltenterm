// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A failed CI on a Reviews row (#797): Rerun failed jobs asks for a confirmation in the row, then wavesrv reruns them
// and a notification tells the outcome; Investigate and fix (#896) hands the failed checks to a work agent
// (ReviewsModel.investigate), which resolves them; a notification tells when the checks pass or why it needs the
// developer. Nothing runs before the developer's click.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { useEscape } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { blockersText, checkNames, checksOf, ReviewPr } from "./reviews-model";
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
    const t = useT();
    const [phase, setPhase] = useState<RerunPhase>("idle");
    const [text, setText] = useState("");
    const cancel = () => {
        setPhase("idle");
        setText("");
    };
    useEscape(phase === "confirm" || phase === "failed" || phase === "started", cancel);
    return {
        phase,
        text,
        ask: () => {
            setText("");
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
                setText(t("reviews.ci.rerun.started", { names: checks.join(", ") }));
                setPhase("started");
            });
        },
        cancel,
    };
}

function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

const SmallButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary";

// The row's actions on a failed check, beside its chips.
export function CiFailureButtons({
    pr,
    rerun,
    investigating,
    onInvestigate,
}: {
    pr: ReviewPr;
    rerun: RerunState;
    investigating: boolean;
    onInvestigate: () => void;
}) {
    const t = useT();
    const failed = checksOf(pr.ci, "failure");
    const blockers = blockersText(pr);
    if (failed.length === 0 && !blockers) {
        return null;
    }
    const names = checkNames(failed);
    return (
        <>
            {rerunnable(pr) ? (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        if (rerun.phase !== "sending") {
                            rerun.ask();
                        }
                    }}
                    onKeyDown={stop}
                    aria-busy={rerun.phase === "sending" || undefined}
                    aria-expanded={rerun.phase === "confirm"}
                    className={SmallButton}
                    title={t("reviews.ci.rerun.buttonTitle", { names })}
                    data-testid="reviews-rerun"
                >
                    {rerun.phase === "sending" ? (
                        <DominoLoader />
                    ) : (
                        <i className="fa fa-solid fa-rotate-right text-11" aria-hidden />
                    )}
                    {rerun.phase === "sending" ? t("reviews.ci.rerun.sending") : t("reviews.ci.rerun.button")}
                </button>
            ) : null}
            {blockers ? (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        if (!investigating) {
                            onInvestigate();
                        }
                    }}
                    onKeyDown={stop}
                    aria-busy={investigating || undefined}
                    className={SmallButton}
                    title={t("reviews.ci.investigate.buttonTitle", { blockers })}
                    data-testid="reviews-investigate"
                >
                    {investigating ? (
                        <DominoLoader />
                    ) : (
                        <i className="fa fa-solid fa-screwdriver-wrench text-11" aria-hidden />
                    )}
                    {investigating ? t("reviews.ci.investigate.asking") : t("reviews.ci.investigate.button")}
                </button>
            ) : null}
        </>
    );
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
