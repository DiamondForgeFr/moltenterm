// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The last page: each step with its state, a way back to the ones left, and Close.

import { cn } from "@/util/util";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { FirstRunPage, OnboardingState, stepPage, stepStatus } from "./onboarding-state";
import { ShownFirstRunSteps } from "./onboarding-steps";

function StatusMark({ status }: { status: string }) {
    const t = useT();
    if (status === "done") {
        return (
            <span className="flex items-center gap-1.5 text-12 text-secondary">
                <i className="fa-solid fa-circle-check text-[var(--mt-state-done)]" aria-hidden />
                {t("onboarding.status.doneTitle")}
            </span>
        );
    }
    if (status === "skipped") {
        return (
            <span className="flex items-center gap-1.5 text-12 text-muted">
                <i className="fa-solid fa-circle-minus" aria-hidden />
                {t("onboarding.status.skippedTitle")}
            </span>
        );
    }
    return (
        <span className="flex items-center gap-1.5 text-12 text-muted">
            <i className="fa-regular fa-circle" aria-hidden />
            {t("onboarding.status.notDoneTitle")}
        </span>
    );
}

export function OnboardingSummary({
    state,
    busy,
    onGo,
    onClose,
}: {
    state: OnboardingState;
    busy: boolean;
    onGo: (page: FirstRunPage) => void;
    onClose: () => void;
}) {
    const t = useT();
    const allDone = ShownFirstRunSteps.every((step) => stepStatus(state, step.id) === "done");
    return (
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
            <div className="flex flex-col gap-1">
                <h2 className="text-20 leading-6 font-semibold text-primary">
                    {t(allDone ? "onboarding.summary.doneTitle" : "onboarding.summary.leftTitle")}
                </h2>
                <p className="text-13 leading-5 text-secondary">
                    {allDone ? t("onboarding.summary.doneText") : t("onboarding.summary.leftText")}
                </p>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-4 border border-border">
                {ShownFirstRunSteps.map((step) => {
                    const status = stepStatus(state, step.id);
                    return (
                        <li key={step.id} className="flex items-center gap-3 px-3 py-2.5">
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="text-13 font-medium text-primary">{t(step.titleKey)}</span>
                                <span className="truncate text-12 text-muted" title={t(step.summaryKey)}>
                                    {t(step.summaryKey)}
                                </span>
                            </div>
                            <StatusMark status={status} />
                            {status !== "done" ? (
                                <button
                                    type="button"
                                    onClick={() => onGo(stepPage(step.id))}
                                    className="molten-btn-secondary cursor-pointer rounded-6 px-2 py-1 text-12"
                                >
                                    {t("common.open")}
                                </button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
            <div>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onClose}
                    className={cn("molten-btn rounded-6 px-4 py-2 text-13 font-semibold", busy && "opacity-60")}
                >
                    {t("common.close")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}
