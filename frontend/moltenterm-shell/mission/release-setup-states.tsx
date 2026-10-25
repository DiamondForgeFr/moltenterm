// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The empty and error states of the pipeline setup (#1106, FR-MC-038): never a silent failure. Each state says what
// happened, what still works and the next action; a soft problem (GitHub not reachable) lets the developer go on with
// less information, and only what the system refuses blocks.

import { cn } from "@/util/util";
import { ReactNode } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import type { SetupDraft } from "./release-setup-model";
import type { GhProblem, SetupSurvey } from "./release-setup-stepper";

const PipelineFile = ".molten/project.json";

const ToneClass = {
    info: "border-border bg-hover",
    warn: "border-warning/40 bg-warning/10",
    bad: "border-error/40 bg-error/10",
};

const IconClass = {
    info: "text-muted",
    warn: "text-warning",
    bad: "text-danger",
};

export const StateButton =
    "cursor-pointer rounded-4 border border-border px-2.5 py-1 text-11 text-secondary hover:bg-hover hover:text-primary";
const GhostButton = "cursor-pointer rounded-4 px-2.5 py-1 text-11 text-muted hover:text-primary";

export function StateCard({
    tone,
    icon,
    title,
    children,
    actions,
    testId,
}: {
    tone: "info" | "warn" | "bad";
    icon: string;
    title: string;
    children?: ReactNode;
    actions?: ReactNode;
    testId?: string;
}) {
    return (
        <div
            className={cn("flex items-start gap-2.5 rounded-6 border px-3 py-2", ToneClass[tone])}
            role={tone === "bad" ? "alert" : "status"}
            data-testid={testId}
        >
            <i className={cn("fa fa-solid mt-0.5 text-12", icon, IconClass[tone])} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-12 font-medium text-primary">{title}</span>
                {children}
                {actions ? <div className="mt-0.5 flex flex-wrap items-center gap-1.5">{actions}</div> : null}
            </div>
        </div>
    );
}

// ghProblemOf: what went wrong with gh, from the releases' read or the protection's; null when GitHub answered or
// the project is not on GitHub.
export function ghProblemOf(survey: SetupSurvey, draft: SetupDraft): { problem: GhProblem; error: string } {
    if (!survey?.releases?.ongithub) {
        return null;
    }
    if (survey.releases.problem) {
        return { problem: survey.releases.problem, error: survey.releases.error ?? "" };
    }
    const protection = draft?.facts?.protection;
    if (protection?.problem) {
        return { problem: protection.problem, error: protection.error ?? "" };
    }
    return null;
}

// Step 1's states: nothing to read, GitHub not reachable, an invalid pipeline, no git repository, no origin.
export function SurveyStates({
    survey,
    draft,
    ghDismissed,
    onDescribe,
    onTemplate,
    onReadAgain,
    onGoOn,
    onOpenFile,
}: {
    survey: SetupSurvey;
    draft: SetupDraft;
    ghDismissed: boolean;
    onDescribe: () => void;
    onTemplate: () => void;
    onReadAgain: () => void;
    onGoOn: () => void;
    onOpenFile: () => void;
}) {
    const t = useT();
    if (survey == null) {
        return null;
    }
    const gh = ghDismissed ? null : ghProblemOf(survey, draft);
    const branch = draft?.facts?.branches?.release || draft?.pr?.target || "";
    const readAgain = (
        <button type="button" className={StateButton} onClick={onReadAgain} data-testid="setup-read-again">
            {t("mc.setup.state.readAgain")}
        </button>
    );
    return (
        <div className="flex flex-col gap-2" data-testid="setup-states">
            {survey.pipeline === "invalid" ? (
                <StateCard
                    tone="bad"
                    icon="fa-circle-exclamation"
                    title={t("mc.setup.state.invalid.title", { path: PipelineFile })}
                    testId="setup-state-invalid"
                    actions={
                        <>
                            <button
                                type="button"
                                className={StateButton}
                                onClick={onOpenFile}
                                data-testid="setup-open-file"
                            >
                                {t("mc.setup.state.invalid.open")}
                            </button>
                            {readAgain}
                        </>
                    }
                >
                    {(survey.pipelineerrors ?? []).length > 0 ? (
                        <ul className="flex flex-col gap-0.5 font-mono text-11 wrap-anywhere text-secondary">
                            {survey.pipelineerrors.map((e) => (
                                <li key={e}>{e}</li>
                            ))}
                        </ul>
                    ) : null}
                    <span className="text-11 text-secondary">{t("mc.setup.state.invalid.sub")}</span>
                </StateCard>
            ) : null}
            {survey.empty && survey.pipeline !== "invalid" ? (
                <StateCard
                    tone="info"
                    icon="fa-magnifying-glass"
                    title={t("mc.setup.state.empty.title")}
                    testId="setup-state-empty"
                    actions={
                        <>
                            <button
                                type="button"
                                className="molten-btn cursor-pointer rounded-4 px-2.5 py-1 text-11"
                                onClick={onDescribe}
                                data-testid="setup-empty-describe"
                            >
                                {t("mc.setup.state.empty.describe")}
                                <MoltenWave />
                            </button>
                            <button
                                type="button"
                                className={StateButton}
                                onClick={onTemplate}
                                data-testid="setup-empty-template"
                            >
                                {t("mc.setup.state.empty.template")}
                            </button>
                        </>
                    }
                >
                    <span className="text-11 text-secondary">{t("mc.setup.state.empty.sub")}</span>
                </StateCard>
            ) : null}
            {survey.git === false ? (
                <StateCard
                    tone="warn"
                    icon="fa-code-branch"
                    title={t("mc.setup.state.noGit.title")}
                    testId="setup-state-nogit"
                    actions={readAgain}
                >
                    <span className="text-11 text-secondary">{t("mc.setup.state.noGit.sub")}</span>
                </StateCard>
            ) : survey.remote === false ? (
                <StateCard
                    tone="warn"
                    icon="fa-code-branch"
                    title={t("mc.setup.state.noRemote.title")}
                    testId="setup-state-noremote"
                >
                    <span className="text-11 text-secondary">{t("mc.setup.state.noRemote.sub")}</span>
                </StateCard>
            ) : null}
            {gh != null ? (
                <StateCard
                    tone="warn"
                    icon="fa-triangle-exclamation"
                    title={t("mc.setup.state.github.title")}
                    testId="setup-state-github"
                    actions={
                        <>
                            {readAgain}
                            <button type="button" className={GhostButton} onClick={onGoOn} data-testid="setup-go-on">
                                {t("mc.setup.state.github.goOn")}
                            </button>
                        </>
                    }
                >
                    <span className="text-11 text-secondary">
                        {branch
                            ? t("mc.setup.state.github.assumed", { branch })
                            : t("mc.setup.state.github.assumedNoBranch")}
                    </span>
                    <span className="text-11 text-secondary" data-testid="setup-state-github-why">
                        {gh.problem === "failed"
                            ? t("mc.setup.state.github.failed", { error: gh.error })
                            : t(`mc.setup.state.github.${gh.problem}`)}
                    </span>
                </StateCard>
            ) : null}
        </div>
    );
}
