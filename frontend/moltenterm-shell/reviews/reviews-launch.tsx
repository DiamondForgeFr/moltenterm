// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Launch in the Reviews view (FR-REV-031): the cards' Launch button and their "running here" line, the launch bar at
// the top of the list (each step, its log, Open, Stop, Retry, Back to the trunk), the confirmation that names what a
// launch replaces and loses, and the recipe dialog. Nothing starts unasked: every action here is the developer's click.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useState } from "react";
import { useT } from "../i18n/i18n";
import { errorPhrase, Phrase, useWordPhrase } from "../i18n/phrase";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { LaunchModel, useLaunchState } from "./reviews-launch-client";
import {
    launchActive,
    launchBackOffered,
    launchFailedStep,
    launchIsOf,
    launchStatusText,
    launchStepError,
    launchStepTitle,
    LaunchTarget,
    launchTargetLabel,
    launchTrunkTarget,
} from "./reviews-launch-model";
import { SecondaryButton, SmallButton, StepMark } from "./reviews-launch-parts";

// Loaded on demand: the dialogs only show once the developer opens a log or asks for a Launch, so their code stays out
// of the JS every tab view loads up front (NFR-PERF-003, bundle.initialJsMB, #2200).
const LaunchLogDialog = lazy(() => import("./reviews-launch-dialogs").then((m) => ({ default: m.LaunchLogDialog })));
const LaunchAskDialogs = lazy(() => import("./reviews-launch-dialogs").then((m) => ({ default: m.LaunchAskDialogs })));

function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

// A card's Launch, or its "running here" line with Open and Stop when it is the launched version. runningOnly: a PR
// card, whose Launch is in its "…" menu (#1060, FR-REV-031 AC10), shows only the running line.
export function LaunchCardActions({
    dir,
    target,
    runningOnly,
}: {
    dir: string;
    target: LaunchTarget;
    runningOnly?: boolean;
}) {
    const t = useT();
    const state = useLaunchState(dir);
    const model = LaunchModel.getInstance();
    const [busy, setBusy] = useState(false);
    const mine = launchIsOf(state, target) && launchActive(state);
    if (!mine && runningOnly) {
        return null;
    }
    if (!mine) {
        return (
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    model.ask(dir, target);
                }}
                onKeyDown={stop}
                className={cn(SecondaryButton, "py-0.5 text-11")}
                title={t("reviews.launch.buttonTitle", { target: launchTargetLabel(t, target) })}
                data-testid="reviews-launch"
            >
                <i className="fa fa-solid fa-rocket text-11" aria-hidden />
                {t("reviews.launch.button")}
            </button>
        );
    }
    const stopIt = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (busy) {
            return;
        }
        setBusy(true);
        fireAndForget(async () => {
            try {
                await model.stop(dir);
            } finally {
                setBusy(false);
            }
        });
    };
    return (
        <span className="flex items-center gap-1.5" data-testid="reviews-launch-running">
            <span className="inline-flex items-center gap-1 rounded-4 border border-success/40 bg-success/10 px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap text-success">
                {state.state === "running" ? (
                    <i className="fa fa-solid fa-circle text-10" aria-hidden />
                ) : (
                    <DominoLoader />
                )}
                {state.state === "running" ? t("reviews.launch.runningHere") : t("reviews.launch.startingHere")}
            </span>
            {state.state === "running" && state.url ? (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        model.open(state);
                    }}
                    onKeyDown={stop}
                    className={SmallButton}
                    title={state.url}
                    data-testid="reviews-launch-open"
                >
                    {t("reviews.launch.open")}
                </button>
            ) : null}
            <button
                type="button"
                onClick={stopIt}
                onKeyDown={stop}
                aria-busy={busy || undefined}
                className={SmallButton}
                data-testid="reviews-launch-stop"
            >
                {busy ? <DominoLoader /> : null}
                {t("reviews.launch.stop")}
            </button>
        </span>
    );
}

// Back to the trunk on a merged card, offered only when that PR is the launched version.
export function LaunchBackButton({ dir, number, trunk }: { dir: string; number: number; trunk: string }) {
    const t = useT();
    const state = useLaunchState(dir);
    if (!launchBackOffered(state, [number])) {
        return null;
    }
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                LaunchModel.getInstance().ask(dir, launchTrunkTarget());
            }}
            onKeyDown={stop}
            className={cn(SecondaryButton, "py-0.5 text-11")}
            title={t("reviews.launch.backTitle", { trunk })}
            data-testid="reviews-launch-back-merged"
        >
            <i className="fa fa-solid fa-arrow-rotate-left text-11" aria-hidden />
            {t("reviews.launch.back", { trunk })}
        </button>
    );
}

// The launch bar: the project's launched version, its steps and what can be done with it.
export function LaunchBar({ dir, mergedNumbers, trunk }: { dir: string; mergedNumbers: number[]; trunk: string }) {
    const t = useT();
    const word = useWordPhrase();
    const state = useLaunchState(dir);
    const model = LaunchModel.getInstance();
    const [busy, setBusy] = useState<string>(null);
    const [error, setError] = useState<Phrase>(null);
    const [logStep, setLogStep] = useState<string>(null);
    if (state == null || state.state === "stopped") {
        return null;
    }
    const act = (name: string, fn: () => Promise<void>) => {
        if (busy) {
            return;
        }
        setBusy(name);
        setError(null);
        fireAndForget(async () => {
            try {
                await fn();
            } catch (e) {
                setError(errorPhrase(e));
            } finally {
                setBusy(null);
            }
        });
    };
    const failed = launchFailedStep(state);
    const back = launchBackOffered(state, mergedNumbers);
    return (
        <section
            className={cn(
                "flex flex-col gap-2 rounded-4 border px-3 py-2",
                state.state === "failed" ? "border-error/50" : "border-border"
            )}
            aria-label={t("reviews.launch.barTitle")}
            data-testid="reviews-launch-bar"
            data-state={state.state}
        >
            <div className="flex flex-wrap items-center gap-2">
                {state.state === "starting" ? (
                    <DominoLoader />
                ) : (
                    <i
                        className={cn(
                            "fa fa-solid text-12",
                            state.state === "running" && "fa-rocket text-success",
                            state.state === "failed" && "fa-triangle-exclamation text-danger"
                        )}
                        aria-hidden
                    />
                )}
                <span className="min-w-0 truncate text-13 leading-5 font-medium" data-testid="reviews-launch-status">
                    {launchStatusText(t, state, trunk)}
                </span>
                {state.target.title ? (
                    <span className="min-w-0 truncate text-12 text-muted">{state.target.title}</span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {state.state === "running" && state.url ? (
                        <button
                            type="button"
                            className={SmallButton}
                            onClick={() => model.open(state)}
                            title={state.url}
                            data-testid="reviews-launch-bar-open"
                        >
                            <i className="fa fa-solid fa-arrow-up-right-from-square text-10" aria-hidden />
                            {t("reviews.launch.open")}
                        </button>
                    ) : null}
                    {state.state === "failed" ? (
                        <button
                            type="button"
                            className="molten-btn flex cursor-pointer items-center gap-1 rounded-4 px-2 py-0.5 text-11"
                            aria-busy={busy === "retry" || undefined}
                            onClick={() => act("retry", () => model.retry(dir))}
                            data-testid="reviews-launch-retry"
                        >
                            {busy === "retry" ? <DominoLoader /> : null}
                            {t("reviews.launch.retry")}
                            <MoltenWave />
                        </button>
                    ) : null}
                    {back ? (
                        <button
                            type="button"
                            className="molten-btn flex cursor-pointer items-center gap-1 rounded-4 px-2 py-0.5 text-11"
                            onClick={() => model.ask(dir, launchTrunkTarget())}
                            title={t("reviews.launch.backTitle", { trunk })}
                            data-testid="reviews-launch-back"
                        >
                            {t("reviews.launch.back", { trunk })}
                            <MoltenWave />
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className={SmallButton}
                        onClick={() => setLogStep((failed ?? state.steps[state.steps.length - 1])?.id)}
                        data-testid="reviews-launch-logs"
                    >
                        {t("reviews.launch.logs")}
                    </button>
                    <button
                        type="button"
                        className={SmallButton}
                        onClick={() => model.ask(dir, state.target, true)}
                        title={t("reviews.launch.recipe.editTitle")}
                        data-testid="reviews-launch-recipe"
                    >
                        {t("reviews.launch.recipe.edit")}
                    </button>
                    <button
                        type="button"
                        className={SmallButton}
                        aria-busy={busy === "stop" || undefined}
                        onClick={() => act("stop", () => model.stop(dir))}
                        data-testid="reviews-launch-bar-stop"
                    >
                        {busy === "stop" ? <DominoLoader /> : null}
                        {t("reviews.launch.stop")}
                    </button>
                </div>
            </div>
            <ol className="flex flex-wrap items-center gap-1.5" aria-label={t("reviews.launch.stepsTitle")}>
                {state.steps.map((step) => (
                    <li key={step.id}>
                        <button
                            type="button"
                            className={cn(
                                "flex cursor-pointer items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 hover:bg-hover",
                                step.state === "failed" ? "border-error/50 text-danger" : "border-border text-secondary"
                            )}
                            onClick={() => setLogStep(step.id)}
                            title={t("reviews.launch.stepLogTitle", { step: launchStepTitle(t, step) })}
                            data-testid="reviews-launch-step"
                            data-step={step.id}
                            data-state={step.state}
                        >
                            <StepMark state={step.state} />
                            {launchStepTitle(t, step)}
                        </button>
                    </li>
                ))}
            </ol>
            {failed ? (
                <p className="text-12 leading-4 text-danger" role="alert" data-testid="reviews-launch-error">
                    {launchStepError(failed)}
                </p>
            ) : null}
            {state.stash ? (
                <p className="text-11 text-muted" data-testid="reviews-launch-stash">
                    {t("reviews.launch.stashed", { stash: state.stash })}
                </p>
            ) : null}
            {error != null ? (
                <p className="text-12 text-danger" role="alert">
                    {word(error)}
                </p>
            ) : null}
            {logStep ? (
                <Suspense fallback={null}>
                    <LaunchLogDialog
                        dir={dir}
                        state={state}
                        step={logStep}
                        onStep={setLogStep}
                        onClose={() => setLogStep(null)}
                    />
                </Suspense>
            ) : null}
        </section>
    );
}

// The dialogs a Launch opens, mounted once by the list: the recipe when none is confirmed (or when asked), then the
// confirmation of what the launch replaces.
export function LaunchDialogs({ trunk }: { trunk: string }) {
    const ask = useAtomValue(LaunchModel.getInstance().askAtom);
    if (ask == null) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <LaunchAskDialogs ask={ask} trunk={trunk} />
        </Suspense>
    );
}

