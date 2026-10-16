// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mark ready for review (#687), on a draft's row in the Reviews list and in its Review tab's header: the button asks
// for a confirmation that says what GitHub does next, then runs gh pr ready through ReviewsModel.markReady.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { useEscape } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { ReviewsModel } from "./reviews-store";

export type MarkReadyPhase = "idle" | "confirm" | "sending" | "failed";

export type MarkReadyState = {
    phase: MarkReadyPhase;
    error: string;
    ask: () => void;
    confirm: () => void;
    cancel: () => void;
};

export function useMarkReady(dir: string, number: number, repo: string): MarkReadyState {
    const [phase, setPhase] = useState<MarkReadyPhase>("idle");
    const [error, setError] = useState("");
    const cancel = () => {
        setPhase("idle");
        setError("");
    };
    useEscape(phase === "confirm" || phase === "failed", cancel);
    return {
        phase,
        error,
        ask: () => {
            setError("");
            setPhase("confirm");
        },
        confirm: () => {
            if (phase === "sending") {
                return;
            }
            setPhase("sending");
            fireAndForget(async () => {
                const failed = await ReviewsModel.getInstance().markReady(dir, number, repo);
                setError(failed);
                setPhase(failed ? "failed" : "idle");
            });
        },
        cancel,
    };
}

// The row's and the header's own clicks and keys stay theirs (a row's click opens the review).
function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

export function MarkReadyButton({ state, className }: { state: MarkReadyState; className?: string }) {
    const t = useT();
    const sending = state.phase === "sending";
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                if (state.phase === "idle" || state.phase === "failed") {
                    state.ask();
                }
            }}
            onKeyDown={stop}
            aria-busy={sending || undefined}
            aria-expanded={state.phase !== "idle"}
            className={cn("molten-btn flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 text-12", className)}
            title={t("reviews.ready.buttonTitle")}
            data-testid="reviews-mark-ready"
        >
            {sending ? <DominoLoader /> : <i className="fa fa-solid fa-eye text-11" />}
            {sending ? t("reviews.ready.sending") : t("reviews.ready.button")}
            <MoltenWave />
        </button>
    );
}

// The confirmation, then the error in plain words; nothing once the PR is ready (the list moves it).
export function MarkReadyConfirm({ state, className }: { state: MarkReadyState; className?: string }) {
    const t = useT();
    if (state.phase === "idle") {
        return null;
    }
    const failed = state.phase === "failed";
    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-2 text-12 leading-4",
                failed ? "text-error" : "text-secondary",
                className
            )}
            role={failed ? "alert" : "status"}
            onClick={stop}
            onKeyDown={stop}
            data-testid="reviews-mark-ready-confirm"
        >
            <span className="min-w-0 flex-1">{failed ? state.error : t("reviews.ready.confirm")}</span>
            {failed ? null : (
                <button
                    type="button"
                    onClick={state.confirm}
                    aria-busy={state.phase === "sending" || undefined}
                    className="molten-btn flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-1 text-12"
                    data-testid="reviews-mark-ready-yes"
                >
                    {state.phase === "sending" ? t("reviews.ready.sending") : t("reviews.ready.confirmButton")}
                    <MoltenWave />
                </button>
            )}
            <button
                type="button"
                onClick={state.cancel}
                className="flex shrink-0 cursor-pointer items-center rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
            >
                {failed ? t("reviews.ready.dismiss") : t("common.cancel")}
            </button>
        </div>
    );
}
