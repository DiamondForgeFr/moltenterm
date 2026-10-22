// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Launch in the Reviews view (FR-REV-031): the cards' Launch button and their "running here" line, the launch bar at
// the top of the list (each step, its log, Open, Stop, Retry, Back to the trunk), the confirmation that names what a
// launch replaces and loses, and the recipe dialog. Nothing starts unasked: every action here is the developer's click.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { TabActivity } from "../tab-activity";
import { LaunchAsk, LaunchModel, useLaunchState } from "./reviews-launch-client";
import {
    launchActive,
    launchBackOffered,
    launchFailedStep,
    launchIsOf,
    LaunchPlan,
    launchPlanLines,
    LaunchRecipe,
    LaunchRecipeAnswer,
    launchRecipeDraft,
    launchRecipeProblem,
    LaunchState,
    launchStatusText,
    LaunchStep,
    launchStepError,
    launchStepTitle,
    LaunchTarget,
    launchTargetLabel,
    launchTrunkTarget,
    parsePort,
} from "./reviews-launch-model";

const SecondaryButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";
const SmallButton =
    "flex shrink-0 cursor-pointer items-center gap-1 rounded-4 border border-border px-1.5 py-0.5 text-11 leading-4 text-secondary hover:bg-hover hover:text-primary";
const Input =
    "min-w-0 rounded-4 border border-border bg-transparent px-1.5 py-1 text-12 text-primary outline-none focus:border-accent";

function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

const StepIcon: Record<string, string> = {
    pending: "fa-circle text-muted",
    done: "fa-check text-success",
    failed: "fa-xmark text-danger",
    stopped: "fa-stop text-muted",
};

// The suite's dominoes are the one working indicator (#739).
function StepMark({ state }: { state: string }) {
    if (state === "running") {
        return <DominoLoader />;
    }
    return <i className={cn("fa fa-solid text-10", StepIcon[state])} aria-hidden />;
}

// A card's Launch, or its "running here" line with Open and Stop when it is the launched version.
export function LaunchCardActions({ dir, target }: { dir: string; target: LaunchTarget }) {
    const t = useT();
    const state = useLaunchState(dir);
    const model = LaunchModel.getInstance();
    const [busy, setBusy] = useState(false);
    const mine = launchIsOf(state, target) && launchActive(state);
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
            <span className="inline-flex items-center gap-1 rounded-3 border border-success/40 bg-success/10 px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap text-success">
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
    const state = useLaunchState(dir);
    const model = LaunchModel.getInstance();
    const [busy, setBusy] = useState<string>(null);
    const [error, setError] = useState<string>(null);
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
                setError(serverErrorText(e));
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
                                "flex cursor-pointer items-center gap-1 rounded-3 border px-1.5 py-0.5 text-11 leading-4 hover:bg-hover",
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
            {error ? (
                <p className="text-12 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
            {logStep ? (
                <LaunchLogDialog
                    dir={dir}
                    state={state}
                    step={logStep}
                    onStep={setLogStep}
                    onClose={() => setLogStep(null)}
                />
            ) : null}
        </section>
    );
}

const LogPollMs = 1000;

function LaunchLogDialog({
    dir,
    state,
    step,
    onStep,
    onClose,
}: {
    dir: string;
    state: LaunchState;
    step: string;
    onStep: (step: string) => void;
    onClose: () => void;
}) {
    const t = useT();
    const [text, setText] = useState("");
    const preRef = useRef<HTMLPreElement>(null);
    const current: LaunchStep = state.steps.find((s) => s.id === step);
    const live = current?.state === "running" || (current?.kind === "server" && current?.state === "done");
    useEffect(() => {
        let from = 0;
        let cancelled = false;
        setText("");
        const read = async () => {
            try {
                const chunk = await LaunchModel.getInstance().log(dir, step, from);
                if (cancelled || chunk == null) {
                    return;
                }
                if (chunk.text) {
                    setText((prev) => (from === 0 ? chunk.text : prev + chunk.text));
                }
                from = chunk.size;
            } catch {
                // The log may not exist yet: the step has not started.
            }
        };
        fireAndForget(read);
        if (!live) {
            return () => {
                cancelled = true;
            };
        }
        const stopPolling = TabActivity.getInstance().every(
            { active: LogPollMs, visible: LogPollMs },
            () => fireAndForget(read),
            "launch-log"
        );
        return () => {
            cancelled = true;
            stopPolling();
        };
    }, [dir, step, live, state.id]);
    useEffect(() => {
        preRef.current?.scrollTo?.({ top: preRef.current.scrollHeight });
    }, [text]);
    return (
        <DialogFrame
            role="reviews-launch-log"
            title={t("reviews.launch.logTitle", { target: launchTargetLabel(t, state.target) })}
            subtitle={current ? launchStepTitle(t, current) : step}
            widthClass="w-[720px]"
            onEscape={onClose}
            onBackdrop={onClose}
            buttons={
                <button type="button" className={SecondaryButton} onClick={onClose}>
                    {t("common.close")}
                </button>
            }
        >
            <div className="flex flex-wrap gap-1.5">
                {state.steps.map((s) => (
                    <button
                        key={s.id}
                        type="button"
                        onClick={() => onStep(s.id)}
                        aria-pressed={s.id === step}
                        className={cn(SmallButton, s.id === step && "border-accent text-primary")}
                    >
                        <StepMark state={s.state} />
                        {launchStepTitle(t, s)}
                    </button>
                ))}
            </div>
            {current?.run ? <code className="text-11 break-all text-muted">{current.run}</code> : null}
            <pre
                ref={preRef}
                className="max-h-[50vh] min-h-32 overflow-auto rounded-4 border border-border bg-surface-1 p-2 text-11 leading-4 whitespace-pre-wrap"
                data-testid="reviews-launch-log"
            >
                {text || t("reviews.launch.logEmpty")}
            </pre>
        </DialogFrame>
    );
}

// The dialogs a Launch opens, mounted once by the list: the recipe when none is confirmed (or when asked), then the
// confirmation of what the launch replaces.
export function LaunchDialogs({ trunk }: { trunk: string }) {
    const model = LaunchModel.getInstance();
    const ask = useAtomValue(model.askAtom);
    const [recipeAnswer, setRecipeAnswer] = useState<LaunchRecipeAnswer>(null);
    const [plan, setPlan] = useState<LaunchPlan>(null);
    const [phase, setPhase] = useState<"loading" | "recipe" | "confirm" | "error">(null);
    const [error, setError] = useState<string>(null);
    const loadPlan = async (current: LaunchAsk) => {
        setPhase("loading");
        try {
            setPlan(await model.plan(current.dir, current.target));
            setPhase("confirm");
        } catch (e) {
            setError(serverErrorText(e));
            setPhase("error");
        }
    };
    useEffect(() => {
        setPlan(null);
        setRecipeAnswer(null);
        setError(null);
        if (ask == null) {
            setPhase(null);
            return;
        }
        setPhase("loading");
        fireAndForget(async () => {
            try {
                const answer = await model.recipe(ask.dir);
                setRecipeAnswer(answer);
                if (ask.recipeOnly || answer.saved == null) {
                    setPhase("recipe");
                    return;
                }
                await loadPlan(ask);
            } catch (e) {
                setError(serverErrorText(e));
                setPhase("error");
            }
        });
    }, [ask]);
    if (ask == null || phase == null || phase === "loading") {
        return null;
    }
    if (phase === "error") {
        return <LaunchErrorDialog text={error} onClose={() => model.closeAsk()} />;
    }
    if (phase === "recipe") {
        return (
            <LaunchRecipeDialog
                dir={ask.dir}
                answer={recipeAnswer}
                launching={!ask.recipeOnly}
                onCancel={() => model.closeAsk()}
                onSaved={(answer) => {
                    setRecipeAnswer(answer);
                    if (ask.recipeOnly) {
                        model.closeAsk();
                        return;
                    }
                    fireAndForget(() => loadPlan(ask));
                }}
            />
        );
    }
    return (
        <LaunchConfirmDialog
            ask={ask}
            plan={plan}
            trunk={trunk}
            onEditRecipe={() => setPhase("recipe")}
            onCancel={() => model.closeAsk()}
        />
    );
}

function LaunchErrorDialog({ text, onClose }: { text: string; onClose: () => void }) {
    const t = useT();
    return (
        <DialogFrame
            role="reviews-launch-error"
            title={t("reviews.launch.errorTitle")}
            onEscape={onClose}
            onBackdrop={onClose}
            buttons={
                <button type="button" className={SecondaryButton} onClick={onClose}>
                    {t("common.close")}
                </button>
            }
        >
            <p className="text-danger" role="alert">
                {text}
            </p>
        </DialogFrame>
    );
}

function LaunchConfirmDialog({
    ask,
    plan,
    trunk,
    onEditRecipe,
    onCancel,
}: {
    ask: LaunchAsk;
    plan: LaunchPlan;
    trunk: string;
    onEditRecipe: () => void;
    onCancel: () => void;
}) {
    const t = useT();
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string>(null);
    const lines = useMemo(() => launchPlanLines(t, plan, ask.target, trunk), [t, plan, ask.target, trunk]);
    const dirty = plan.dirtycount > 0;
    const label = launchTargetLabel(t, ask.target, trunk);
    const start = () => {
        if (starting) {
            return;
        }
        setStarting(true);
        setError(null);
        fireAndForget(async () => {
            try {
                await LaunchModel.getInstance().start(ask.dir, ask.target, dirty, plan.holders.length > 0);
                LaunchModel.getInstance().closeAsk();
            } catch (e) {
                setError(serverErrorText(e));
                setStarting(false);
            }
        });
    };
    return (
        <DialogFrame
            role="reviews-launch-confirm"
            title={
                ask.target.kind === "trunk"
                    ? t("reviews.launch.confirm.backTitle", { trunk: label })
                    : t("reviews.launch.confirm.title", { target: label })
            }
            subtitle={ask.target.title}
            widthClass="w-[560px]"
            onEscape={onCancel}
            buttons={
                <>
                    <button
                        type="button"
                        className={cn(SecondaryButton, "mr-auto")}
                        onClick={onEditRecipe}
                        data-testid="reviews-launch-confirm-recipe"
                    >
                        {t("reviews.launch.recipe.edit")}
                    </button>
                    <button
                        type="button"
                        className={SecondaryButton}
                        onClick={onCancel}
                        data-testid="reviews-launch-confirm-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn flex cursor-pointer items-center gap-1.5 rounded-4 px-3 py-1 text-12"
                        aria-busy={starting || undefined}
                        onClick={start}
                        data-testid="reviews-launch-confirm-start"
                    >
                        {starting ? <DominoLoader /> : null}
                        {dirty ? t("reviews.launch.confirm.stashAndLaunch") : t("reviews.launch.confirm.launch")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <ul className="flex flex-col gap-1.5 text-12 leading-5" data-testid="reviews-launch-confirm">
                {lines.map((line) => (
                    <li
                        key={line.key}
                        className={cn(
                            line.tone === "warning"
                                ? "text-warning"
                                : line.tone === "muted"
                                  ? "text-muted"
                                  : "text-secondary"
                        )}
                        data-line={line.key}
                    >
                        {line.text}
                    </li>
                ))}
            </ul>
            {dirty ? (
                <div
                    className="flex flex-col gap-1.5 rounded-4 border border-warning/50 px-2.5 py-2"
                    data-testid="reviews-launch-dirty"
                >
                    <p className="text-12 leading-5 text-warning">
                        {t("reviews.launch.confirm.dirty", { count: plan.dirtycount })}
                    </p>
                    <ul className="max-h-28 overflow-auto font-mono text-11 text-secondary">
                        {plan.dirty.map((file) => (
                            <li key={file}>{file}</li>
                        ))}
                    </ul>
                    <p className="text-11 leading-4 text-muted">{t("reviews.launch.confirm.dirtyStash")}</p>
                </div>
            ) : null}
            {error ? (
                <p className="text-12 text-danger" role="alert" data-testid="reviews-launch-confirm-error">
                    {error}
                </p>
            ) : null}
        </DialogFrame>
    );
}

function LaunchRecipeDialog({
    dir,
    answer,
    launching,
    onCancel,
    onSaved,
}: {
    dir: string;
    answer: LaunchRecipeAnswer;
    launching: boolean;
    onCancel: () => void;
    onSaved: (answer: LaunchRecipeAnswer) => void;
}) {
    const t = useT();
    const [recipe, setRecipe] = useState<LaunchRecipe>(() => launchRecipeDraft(answer));
    const [portTexts, setPortTexts] = useState<string[]>(() =>
        recipe.servers.map((s) => (s.port ? String(s.port) : ""))
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>(null);
    const withPorts: LaunchRecipe = {
        ...recipe,
        servers: recipe.servers.map((s, i) => ({ ...s, port: parsePort(portTexts[i] ?? "") })),
    };
    const problem = launchRecipeProblem(t, withPorts);
    const source = answer?.saved
        ? t("reviews.launch.recipe.fromSaved")
        : answer?.proposalfrom === "project"
          ? t("reviews.launch.recipe.fromProject")
          : answer?.proposalfrom === "detected"
            ? t("reviews.launch.recipe.fromDetected")
            : t("reviews.launch.recipe.fromNothing");
    const setStep = (i: number, change: Partial<LaunchRecipe["prepare"][number]>) =>
        setRecipe({ ...recipe, prepare: recipe.prepare.map((s, j) => (j === i ? { ...s, ...change } : s)) });
    const setServer = (i: number, change: Partial<LaunchRecipe["servers"][number]>) =>
        setRecipe({ ...recipe, servers: recipe.servers.map((s, j) => (j === i ? { ...s, ...change } : s)) });
    const save = () => {
        if (saving) {
            return;
        }
        if (problem) {
            setError(problem);
            return;
        }
        setSaving(true);
        setError(null);
        fireAndForget(async () => {
            try {
                onSaved(await LaunchModel.getInstance().saveRecipe(dir, withPorts));
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setSaving(false);
            }
        });
    };
    return (
        <DialogFrame
            role="reviews-launch-recipe"
            title={t("reviews.launch.recipe.title")}
            subtitle={source}
            subtitleWraps
            widthClass="w-[680px]"
            onEscape={onCancel}
            buttons={
                <>
                    <button
                        type="button"
                        className={SecondaryButton}
                        onClick={onCancel}
                        data-testid="reviews-launch-recipe-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn flex cursor-pointer items-center gap-1.5 rounded-4 px-3 py-1 text-12"
                        aria-busy={saving || undefined}
                        onClick={save}
                        data-testid="reviews-launch-recipe-save"
                    >
                        {saving ? <DominoLoader /> : null}
                        {launching ? t("reviews.launch.recipe.saveContinue") : t("common.save")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div className="flex flex-col gap-3 text-12" data-testid="reviews-launch-recipe-form">
                <p className="text-11 leading-4 text-muted">{t("reviews.launch.recipe.intro")}</p>
                <fieldset className="flex flex-col gap-1">
                    <legend className="mb-1 font-semibold">{t("reviews.launch.recipe.where")}</legend>
                    {(["main", "worktree"] as const).map((where) => (
                        <label key={where} className="flex cursor-pointer items-start gap-2">
                            <input
                                type="radio"
                                className="mt-1 cursor-pointer"
                                checked={(recipe.where || "main") === where}
                                onChange={() => setRecipe({ ...recipe, where })}
                            />
                            <span>
                                {where === "main"
                                    ? t("reviews.launch.recipe.whereMain")
                                    : t("reviews.launch.recipe.whereWorktree")}
                            </span>
                        </label>
                    ))}
                </fieldset>
                <section className="flex flex-col gap-1.5">
                    <h3 className="font-semibold">{t("reviews.launch.recipe.prepare")}</h3>
                    <p className="text-11 text-muted">{t("reviews.launch.recipe.prepareHint")}</p>
                    {recipe.prepare.map((step, i) => (
                        <div key={i} className="flex items-center gap-1.5" data-testid="reviews-launch-recipe-step">
                            <input
                                className={cn(Input, "w-28")}
                                value={step.id}
                                placeholder={t("reviews.launch.recipe.name")}
                                aria-label={t("reviews.launch.recipe.name")}
                                onChange={(e) => setStep(i, { id: e.target.value })}
                            />
                            <input
                                className={cn(Input, "flex-1 font-mono")}
                                value={step.run}
                                placeholder={t("reviews.launch.recipe.command")}
                                aria-label={t("reviews.launch.recipe.command")}
                                onChange={(e) => setStep(i, { run: e.target.value })}
                            />
                            <input
                                className={cn(Input, "w-28 font-mono")}
                                value={step.cwd ?? ""}
                                placeholder={t("reviews.launch.recipe.folder")}
                                aria-label={t("reviews.launch.recipe.folder")}
                                onChange={(e) => setStep(i, { cwd: e.target.value })}
                            />
                            <RemoveButton
                                onClick={() =>
                                    setRecipe({ ...recipe, prepare: recipe.prepare.filter((_, j) => j !== i) })
                                }
                            />
                        </div>
                    ))}
                    <button
                        type="button"
                        className={cn(SmallButton, "w-fit")}
                        onClick={() => setRecipe({ ...recipe, prepare: [...recipe.prepare, { id: "", run: "" }] })}
                    >
                        <i className="fa fa-solid fa-plus text-10" aria-hidden />
                        {t("reviews.launch.recipe.addStep")}
                    </button>
                </section>
                <section className="flex flex-col gap-1.5">
                    <h3 className="font-semibold">{t("reviews.launch.recipe.servers")}</h3>
                    <p className="text-11 text-muted">{t("reviews.launch.recipe.serversHint")}</p>
                    {recipe.servers.map((server, i) => (
                        <div key={i} className="flex items-center gap-1.5" data-testid="reviews-launch-recipe-server">
                            <input
                                className={cn(Input, "w-24")}
                                value={server.id}
                                placeholder={t("reviews.launch.recipe.name")}
                                aria-label={t("reviews.launch.recipe.name")}
                                onChange={(e) => setServer(i, { id: e.target.value })}
                            />
                            <input
                                className={cn(Input, "flex-1 font-mono")}
                                value={server.run}
                                placeholder={t("reviews.launch.recipe.command")}
                                aria-label={t("reviews.launch.recipe.command")}
                                onChange={(e) => setServer(i, { run: e.target.value })}
                            />
                            <input
                                className={cn(Input, "w-24 font-mono")}
                                value={server.cwd ?? ""}
                                placeholder={t("reviews.launch.recipe.folder")}
                                aria-label={t("reviews.launch.recipe.folder")}
                                onChange={(e) => setServer(i, { cwd: e.target.value })}
                            />
                            <input
                                className={cn(Input, "w-16 font-mono")}
                                inputMode="numeric"
                                value={portTexts[i] ?? ""}
                                placeholder={t("reviews.launch.recipe.port")}
                                aria-label={t("reviews.launch.recipe.port")}
                                onChange={(e) => {
                                    const next = [...portTexts];
                                    next[i] = e.target.value;
                                    setPortTexts(next);
                                }}
                            />
                            <RemoveButton
                                onClick={() => {
                                    setRecipe({ ...recipe, servers: recipe.servers.filter((_, j) => j !== i) });
                                    setPortTexts(portTexts.filter((_, j) => j !== i));
                                }}
                            />
                        </div>
                    ))}
                    <button
                        type="button"
                        className={cn(SmallButton, "w-fit")}
                        onClick={() => {
                            setRecipe({ ...recipe, servers: [...recipe.servers, { id: "", run: "" }] });
                            setPortTexts([...portTexts, ""]);
                        }}
                    >
                        <i className="fa fa-solid fa-plus text-10" aria-hidden />
                        {t("reviews.launch.recipe.addServer")}
                    </button>
                </section>
                <label className="flex flex-col gap-1">
                    <span className="font-semibold">{t("reviews.launch.recipe.url")}</span>
                    <input
                        className={cn(Input, "font-mono")}
                        value={recipe.url ?? ""}
                        placeholder="http://localhost:5173"
                        onChange={(e) => setRecipe({ ...recipe, url: e.target.value })}
                        data-testid="reviews-launch-recipe-url"
                    />
                    <span className="text-11 text-muted">{t("reviews.launch.recipe.urlHint")}</span>
                </label>
                {error ? (
                    <p className="text-danger" role="alert" data-testid="reviews-launch-recipe-error">
                        {error}
                    </p>
                ) : null}
            </div>
        </DialogFrame>
    );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-4 text-muted hover:bg-hover hover:text-primary"
            aria-label={t("reviews.launch.recipe.remove")}
            title={t("reviews.launch.recipe.remove")}
        >
            <i className="fa fa-solid fa-xmark text-11" aria-hidden />
        </button>
    );
}
