// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A failed release step's ways out (#945, FR-MC-016), as the Reviews' failed CI has them (reviews-ci-actions.tsx):
// Rerun failed jobs (the GitHub runs the step names, after a confirmation in the card), Analyze and resolve (a work
// agent out of sight, under the release's rules, that reports by notification) and Investigate together (a tab, shown,
// with the failing logs beside an agent primed with the failure). Nothing starts before the developer's click.

import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText, serverText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import type { AgentMode, ReviewRestartResult } from "../review/review-client";
import { DominoLoader } from "../suite/suite";
import type { FailedRun, Phase } from "./release-run";

export type ReleaseResolveActions = {
    rerunRuns: (runs: FailedRun[]) => Promise<void>;
    resolve: (phase: Phase, mode: AgentMode) => Promise<{ result: ReviewRestartResult; tab: string }>;
};

const SmallButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

type Busy = "" | "rerun" | AgentMode;

// resolveText: what the card says once wavesrv answered a start.
export function resolveText(
    t: (key: string, vars?: Record<string, string | number>) => string,
    result: ReviewRestartResult,
    mode: AgentMode,
    step: string,
    tab: string
): { text: string; error: boolean } {
    const name = result?.agentname || t("agentChoice.yourAgent");
    if (result?.status === "started") {
        return mode === "together"
            ? { text: t("mc.releaseRun.resolve.startedTogether", { name, tab }), error: false }
            : { text: t("mc.releaseRun.resolve.started", { name, step }), error: false };
    }
    const message = serverText(result?.messagetext, result?.message ?? "");
    return { text: t("mc.releaseRun.resolve.failed", { message }), error: true };
}

export function ReleaseFailureActions({ phase, actions }: { phase: Phase; actions: ReleaseResolveActions }) {
    const t = useT();
    const [busy, setBusy] = useState<Busy>("");
    const [confirming, setConfirming] = useState(false);
    const [said, setSaid] = useState<{ text: string; error: boolean }>(null);
    const failure = phase.failure;
    if (phase.status !== "failed" || failure == null) {
        return null;
    }
    const runs = failure.runs ?? [];
    const names = runs.map((r) => r.name).join(", ");
    // The build's own action already reruns the release workflow's failed jobs.
    const rerunnable = runs.length > 0 && phase.action?.kind !== "rerun";
    const rerun = () =>
        fireAndForget(async () => {
            setBusy("rerun");
            setSaid(null);
            try {
                await actions.rerunRuns(runs);
                setConfirming(false);
                setSaid({ text: t("mc.releaseRun.resolve.rerunStarted", { names }), error: false });
            } catch (e) {
                setSaid({ text: serverErrorText(e), error: true });
            } finally {
                setBusy("");
            }
        });
    const start = (mode: AgentMode) =>
        fireAndForget(async () => {
            setBusy(mode);
            setSaid(null);
            setConfirming(false);
            try {
                const { result, tab } = await actions.resolve(phase, mode);
                setSaid(resolveText(t, result, mode, failure.step, tab));
            } catch (e) {
                setSaid({ text: t("mc.releaseRun.resolve.failed", { message: serverErrorText(e) }), error: true });
            } finally {
                setBusy("");
            }
        });
    return (
        <div className="mt-3 flex flex-col gap-2" data-testid="release-run-resolve">
            <div className="flex flex-wrap justify-end gap-2">
                {rerunnable ? (
                    <button
                        type="button"
                        className={SmallButton}
                        disabled={busy !== ""}
                        aria-expanded={confirming}
                        title={t("mc.releaseRun.resolve.rerunTitle", { names })}
                        onClick={() => setConfirming(true)}
                        data-testid="release-run-rerun-failed"
                    >
                        {busy === "rerun" ? <DominoLoader /> : <i className="fa fa-solid fa-rotate-right text-11" />}
                        {busy === "rerun" ? t("mc.releaseRun.resolve.rerunning") : t("mc.releaseRun.resolve.rerun")}
                    </button>
                ) : null}
                <button
                    type="button"
                    className={SmallButton}
                    disabled={busy !== ""}
                    title={t("mc.releaseRun.resolve.analyzeTitle", { step: failure.step })}
                    onClick={() => start("background")}
                    data-testid="release-run-analyze"
                >
                    {busy === "background" ? (
                        <DominoLoader />
                    ) : (
                        <i className="fa fa-solid fa-screwdriver-wrench text-11" />
                    )}
                    {busy === "background" ? t("mc.releaseRun.resolve.asking") : t("mc.releaseRun.resolve.analyze")}
                </button>
                <button
                    type="button"
                    className={SmallButton}
                    disabled={busy !== ""}
                    title={t("mc.releaseRun.resolve.togetherTitle", { step: failure.step })}
                    onClick={() => start("together")}
                    data-testid="release-run-together"
                >
                    {busy === "together" ? <DominoLoader /> : <i className="fa fa-solid fa-terminal text-11" />}
                    {busy === "together" ? t("mc.releaseRun.resolve.asking") : t("mc.releaseRun.resolve.together")}
                </button>
            </div>
            {confirming ? (
                <div
                    className="flex flex-wrap items-center gap-2 rounded-4 border border-border px-2 py-1.5 text-12 text-secondary"
                    role="status"
                    data-testid="release-run-rerun-confirm"
                >
                    <span className="min-w-0 flex-1">{t("mc.releaseRun.resolve.rerunConfirm", { names })}</span>
                    <button
                        type="button"
                        className="cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                        onClick={() => setConfirming(false)}
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn flex cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-1 text-12"
                        disabled={busy !== ""}
                        onClick={rerun}
                        data-testid="release-run-rerun-yes"
                    >
                        {busy === "rerun" ? t("mc.releaseRun.resolve.rerunning") : t("mc.releaseRun.resolve.rerunYes")}
                        <MoltenWave />
                    </button>
                </div>
            ) : null}
            {said ? (
                <p
                    className={said.error ? "text-right text-12 text-danger" : "text-right text-12 text-secondary"}
                    role={said.error ? "alert" : "status"}
                    data-testid="release-run-resolve-said"
                >
                    {said.text}
                </p>
            ) : null}
        </div>
    );
}
