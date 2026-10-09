// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The last page: each step with its state, a way back to the ones left, and Close.

import { cn } from "@/util/util";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { FirstRunPage, OnboardingState, stepPage, stepStatus } from "./onboarding-state";
import { FirstRunSteps } from "./onboarding-steps";

function StatusMark({ status }: { status: string }) {
    if (status === "done") {
        return (
            <span className="flex items-center gap-1.5 text-12 text-secondary">
                <i className="fa-solid fa-circle-check text-[var(--mt-state-done)]" aria-hidden />
                Done
            </span>
        );
    }
    if (status === "skipped") {
        return (
            <span className="flex items-center gap-1.5 text-12 text-muted">
                <i className="fa-solid fa-circle-minus" aria-hidden />
                Skipped
            </span>
        );
    }
    return (
        <span className="flex items-center gap-1.5 text-12 text-muted">
            <i className="fa-regular fa-circle" aria-hidden />
            Not done
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
    const allDone = FirstRunSteps.every((step) => stepStatus(state, step.id) === "done");
    return (
        <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
            <div className="flex flex-col gap-1">
                <h2 className="text-20 leading-6 font-semibold text-primary">
                    {allDone ? "You're set" : "Almost there"}
                </h2>
                <p className="text-13 leading-5 text-secondary">
                    {allDone
                        ? "MoltenTerm knows your agent, has taken a first shape and works in your project."
                        : "The steps you left wait for you. Getting started stays in the app menu and the command palette."}
                </p>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-4 border border-border">
                {FirstRunSteps.map((step) => {
                    const status = stepStatus(state, step.id);
                    return (
                        <li key={step.id} className="flex items-center gap-3 px-3 py-2.5">
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="text-13 font-medium text-primary">{step.title}</span>
                                <span className="truncate text-12 text-muted" title={step.summary}>
                                    {step.summary}
                                </span>
                            </div>
                            <StatusMark status={status} />
                            {status !== "done" ? (
                                <button
                                    type="button"
                                    onClick={() => onGo(stepPage(step.id))}
                                    className="molten-btn-secondary cursor-pointer rounded-6 px-2 py-1 text-12"
                                >
                                    Open
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
                    Close
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}
