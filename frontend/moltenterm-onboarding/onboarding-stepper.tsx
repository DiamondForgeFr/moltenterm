// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first run's progress marker. A state always reads by its form as well as its colour (FR-SHELL-014): a check for
// done, a dash and "Skipped" for a skipped step, an accent ring around the current number. Every entry goes to its page.

import { cn } from "@/util/util";
import { Fragment } from "react";
import { FirstRunPage, OnboardingState, progressLabel, stepPage, stepStatus } from "./onboarding-state";
import { FirstRunSteps } from "./onboarding-steps";

type StepperEntry = {
    page: FirstRunPage;
    label: string;
    tooltip: string;
    number: number;
    status: "todo" | "done" | "skipped";
};

function stepperEntries(state: OnboardingState): StepperEntry[] {
    const welcome: StepperEntry = {
        page: "welcome",
        label: "Welcome",
        tooltip: "What MoltenTerm is",
        number: 0,
        status: state.welcomets > 0 ? "done" : "todo",
    };
    return [
        welcome,
        ...FirstRunSteps.map((step, index) => ({
            page: stepPage(step.id),
            label: step.label,
            tooltip: step.summary,
            number: index + 1,
            status: stepStatus(state, step.id),
        })),
    ];
}

function Marker({ entry, current }: { entry: StepperEntry; current: boolean }) {
    if (entry.status === "done") {
        return <i className="fa-solid fa-circle-check text-icon-14 text-[var(--mt-state-done)]" aria-hidden />;
    }
    if (entry.status === "skipped") {
        return <i className="fa-solid fa-circle-minus text-icon-14 text-muted" aria-hidden />;
    }
    return (
        <span
            className={cn(
                "flex h-[15px] w-[15px] items-center justify-center rounded-full border text-11 font-semibold tabular-nums",
                current ? "border-accent text-accent ring-2 ring-accent/30" : "border-[var(--mt-text-muted)] text-muted"
            )}
            aria-hidden
        >
            {entry.number > 0 ? entry.number : ""}
        </span>
    );
}

function statusText(entry: StepperEntry): string {
    if (entry.status === "done") {
        return "done";
    }
    if (entry.status === "skipped") {
        return "skipped";
    }
    return "not done";
}

export function OnboardingStepper({
    state,
    page,
    onGo,
}: {
    state: OnboardingState;
    page: FirstRunPage;
    onGo: (page: FirstRunPage) => void;
}) {
    const entries = stepperEntries(state);
    return (
        <nav aria-label="Setup progress" className="flex min-w-0 items-center gap-3">
            <ol className="flex min-w-0 items-center gap-1">
                {entries.map((entry, index) => {
                    const current = entry.page === page;
                    return (
                        <Fragment key={entry.page}>
                            {index > 0 ? (
                                <li aria-hidden className="h-px w-2 shrink-0 bg-border @min-[540px]:w-3" />
                            ) : null}
                            <li className="shrink-0">
                                <button
                                    type="button"
                                    onClick={() => onGo(entry.page)}
                                    title={`${entry.label}: ${entry.tooltip}`}
                                    aria-label={`${entry.label}, ${statusText(entry)}`}
                                    aria-current={current ? "step" : undefined}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-1.5 rounded-6 px-1.5 py-1 text-12 transition-colors duration-120 ease-mt hover:bg-hoverbg",
                                        current ? "bg-hover text-primary" : "text-secondary"
                                    )}
                                >
                                    <Marker entry={entry} current={current} />
                                    <span className="hidden @min-[540px]:inline">{entry.label}</span>
                                    {entry.status === "skipped" ? (
                                        <span className="hidden text-muted @min-[540px]:inline">Skipped</span>
                                    ) : null}
                                </button>
                            </li>
                        </Fragment>
                    );
                })}
            </ol>
            <span className="truncate text-12 text-muted @min-[540px]:hidden">{progressLabel(page)}</span>
        </nav>
    );
}
