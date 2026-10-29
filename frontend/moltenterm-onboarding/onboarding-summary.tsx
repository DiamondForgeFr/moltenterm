// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The last page: each step with its state, a way back to the ones left, and Close; on a fresh install, the starter
// workspace's views and the first of them to open next (FR-SHELL-110).

import { atoms } from "@/app/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useLocale, useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { templateViewsText, useTemplateViews } from "../moltenterm-shell/workspace-views/template-views";
import { templateViewName } from "../moltenterm-shell/workspace-views/workspace-views-model";
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
    onOpenView,
}: {
    state: OnboardingState;
    busy: boolean;
    onGo: (page: FirstRunPage) => void;
    onClose: () => void;
    onOpenView: () => void;
}) {
    const t = useT();
    const locale = useLocale();
    const ws = useAtomValue(atoms.workspace);
    const template = useTemplateViews();
    const allDone = ShownFirstRunSteps.every((step) => stepStatus(state, step.id) === "done");
    // A fresh install's starter workspace gets the template's views when the run ends (FR-SHELL-110): the summary says
    // so and offers the first of them as the next step.
    const starter = template.length > 0 && !!state.starterws && state.starterws === ws?.oid;
    const closeButton = (
        <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className={cn(
                starter
                    ? "molten-btn-secondary cursor-pointer rounded-6 px-3 py-2 text-13"
                    : "molten-btn rounded-6 px-4 py-2 text-13 font-semibold",
                busy && "opacity-60"
            )}
            data-testid="first-run-close"
        >
            {t("common.close")}
            {starter ? null : <MoltenWave />}
        </button>
    );
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
            {starter ? (
                <div className="flex flex-col gap-3" data-testid="first-run-starter-views">
                    <p className="text-13 leading-5 text-secondary">
                        {t("onboarding.summary.starterViews", { views: templateViewsText(template, t, locale) })}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={onOpenView}
                            className={cn("molten-btn rounded-6 px-4 py-2 text-13 font-semibold", busy && "opacity-60")}
                            data-testid="first-run-open-view"
                        >
                            {t("onboarding.summary.openView", { view: templateViewName(template[0], t) })}
                            <MoltenWave />
                        </button>
                        {closeButton}
                    </div>
                </div>
            ) : (
                <div>{closeButton}</div>
            )}
        </div>
    );
}
