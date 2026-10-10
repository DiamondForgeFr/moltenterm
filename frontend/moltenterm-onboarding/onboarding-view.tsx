// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first-run panel (FR-ONB-001, DS-ONB-001): a block docked on the left of the tab, so the panes its steps open
// land on its right, it resizes like any pane and it stays in place across a restart. Its page lives in its block
// meta; the record of the run lives in the client meta, written by wavesrv.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { ClientModel } from "@/app/store/client-model";
import { replaceBlock } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { getActiveTabModel } from "@/app/store/tab-model";
import * as WOS from "@/app/store/wos";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { onboardingUpdate, OnboardingUpdate, setPanelPage } from "./onboarding-client";
import { openBesidePanel } from "./onboarding-open";
import {
    FirstRunPage,
    FirstRunStepId,
    MoltentermOnboardingView,
    OnboardingMetaKey,
    OnboardingPageMetaKey,
    OnboardingState,
    pageAfter,
    pageStep,
    panelPage,
    progressLabel,
    readOnboardingState,
    reopenPage,
} from "./onboarding-state";
import { OnboardingStepper } from "./onboarding-stepper";
import { findFirstRunStep, FirstRunStep, FirstRunStepContext, ShownStepIds } from "./onboarding-steps";
import { OnboardingSummary } from "./onboarding-summary";
import { OnboardingWelcome } from "./onboarding-welcome";

export { MoltentermOnboardingView };

export class OnboardingViewModel implements ViewModel {
    viewType = MoltentermOnboardingView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("compass");
    viewName = atom("Getting started");
    noPadding = atom(true);
    busyAtom = atom(false) as PrimitiveAtom<boolean>;
    errorAtom = atom(null) as PrimitiveAtom<string>;
    blockAtom: Atom<Block>;

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
    }

    get viewComponent(): ViewComponent {
        return FirstRunPanel;
    }

    // One action at a time; a failure stays on the panel until the next action.
    async run(fn: () => Promise<void>): Promise<void> {
        if (globalStore.get(this.busyAtom)) {
            return;
        }
        globalStore.set(this.busyAtom, true);
        globalStore.set(this.errorAtom, null);
        try {
            await fn();
        } catch (e) {
            globalStore.set(this.errorAtom, `${e?.message ?? e}`);
        } finally {
            globalStore.set(this.busyAtom, false);
        }
    }

    update(update: OnboardingUpdate): Promise<OnboardingState> {
        return onboardingUpdate(update);
    }

    goTo(page: FirstRunPage): Promise<void> {
        return this.run(() => setPanelPage(this.blockId, page));
    }

    start(): Promise<void> {
        return this.run(async () => {
            const state = await this.update({ kind: "welcome" });
            await setPanelPage(this.blockId, reopenPage(state, ShownStepIds));
        });
    }

    // Skip setup, Leave setup and Close all end the run, then take the panel away; Getting started brings it back.
    // Closing the last pane of a tab closes the tab, and the window with its last tab: a panel left alone in its tab
    // gives way to a terminal instead.
    private endAndClose(kind: "leave" | "finish"): Promise<void> {
        return this.run(async () => {
            await this.update({ kind });
            const tabAtom = getActiveTabModel()?.tabAtom;
            const blockCount = tabAtom == null ? 0 : (globalStore.get(tabAtom)?.blockids?.length ?? 0);
            if (blockCount === 1) {
                await replaceBlock(this.blockId, { meta: { view: "term", controller: "shell" } }, true);
                return;
            }
            uxCloseBlock(this.blockId);
        });
    }

    leave(): Promise<void> {
        return this.endAndClose("leave");
    }

    finish(): Promise<void> {
        return this.endAndClose("finish");
    }

    // Records the step, then moves to the next step not done after it (skipping always moves forward).
    async moveOn(stepId: FirstRunStepId, status: "done" | "skipped"): Promise<void> {
        const next = await this.update({ kind: "step", step: stepId, status });
        await setPanelPage(this.blockId, pageAfter(next, stepId, ShownStepIds));
    }

    stepContext(step: FirstRunStep, state: OnboardingState): FirstRunStepContext {
        return {
            panelBlockId: this.blockId,
            state,
            data: state.data[step.id] ?? {},
            setData: async (patch) => {
                await this.update({ kind: "data", step: step.id, data: patch });
            },
            complete: () => this.run(() => this.moveOn(step.id, "done")),
            skip: () => this.run(() => this.moveOn(step.id, "skipped")),
            openBeside: (blockdef) => openBesidePanel(this.blockId, blockdef),
        };
    }
}

function StepFailed({ error }: { error?: Error }) {
    return <p className="text-13 text-error">This step could not be shown: {error?.message ?? "unknown error"}</p>;
}

function StepPage({ model, step, state }: { model: OnboardingViewModel; step: FirstRunStep; state: OnboardingState }) {
    const ctx = useMemo(() => model.stepContext(step, state), [model, step, state]);
    const Component = step.component;
    return (
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
            <div className="flex flex-col gap-1">
                <span className="text-12 text-muted">{progressLabel(`step:${step.id}`, ShownStepIds)}</span>
                <h2 className="text-20 leading-6 font-semibold text-primary">{step.title}</h2>
                <p className="text-13 leading-5 text-secondary">{step.summary}</p>
            </div>
            <ErrorBoundary key={step.id} fallback={<StepFailed />}>
                <Component ctx={ctx} />
            </ErrorBoundary>
        </div>
    );
}

function StepFooter({ model, step, busy }: { model: OnboardingViewModel; step: FirstRunStep; busy: boolean }) {
    return (
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <button
                type="button"
                disabled={busy}
                onClick={() => model.leave()}
                className="molten-btn-ghost cursor-pointer rounded-6 px-2 py-1.5 text-12 text-muted hover:text-primary"
            >
                Leave setup
            </button>
            {step.placeholder ? (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => model.run(() => model.moveOn(step.id, "skipped"))}
                    className="molten-btn ml-auto cursor-pointer rounded-6 px-4 py-1.5 text-12 font-medium"
                    data-testid="first-run-next"
                >
                    Next
                    <MoltenWave />
                </button>
            ) : (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => model.run(() => model.moveOn(step.id, "skipped"))}
                    className="molten-btn-secondary ml-auto cursor-pointer rounded-6 px-3 py-1.5 text-12"
                >
                    Skip this step
                </button>
            )}
        </div>
    );
}

export function FirstRunPanel({ model }: ViewComponentProps<OnboardingViewModel>) {
    const client = useAtomValue(ClientModel.getInstance().clientAtom);
    const block = useAtomValue(model.blockAtom);
    const busy = useAtomValue(model.busyAtom);
    const error = useAtomValue(model.errorAtom);
    // The client changes with every notification: the state, and the step context built on it, change only with the
    // record, so a step's effects do not run again for unrelated updates.
    const recordKey = JSON.stringify(client?.meta?.[OnboardingMetaKey] ?? null);
    const state = useMemo(
        () => readOnboardingState({ [OnboardingMetaKey]: JSON.parse(recordKey) } as MetaType),
        [recordKey]
    );
    const page = panelPage(state, block?.meta?.[OnboardingPageMetaKey], ShownStepIds);
    const stepId = pageStep(page);
    const step = stepId == null ? null : findFirstRunStep(stepId);
    return (
        <div
            className="@container flex h-full w-full flex-col overflow-hidden bg-[var(--mt-neutral-panel)] font-[family-name:var(--mt-ui-font)] text-primary"
            data-first-run-page={page}
        >
            {page !== "welcome" ? (
                <header className="flex shrink-0 items-center border-b border-border px-4 py-2">
                    <OnboardingStepper state={state} page={page} onGo={(next) => model.goTo(next)} />
                </header>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
                {page === "welcome" ? (
                    <OnboardingWelcome busy={busy} onStart={() => model.start()} onSkip={() => model.leave()} />
                ) : null}
                {step != null ? <StepPage model={model} step={step} state={state} /> : null}
                {page === "summary" ? (
                    <OnboardingSummary
                        state={state}
                        busy={busy}
                        onGo={(next) => model.goTo(next)}
                        onClose={() => model.finish()}
                    />
                ) : null}
                {error ? (
                    <p className="mx-auto mt-4 w-full max-w-[560px] text-12 text-error" role="alert">
                        {error}
                    </p>
                ) : null}
            </div>
            {step != null ? <StepFooter model={model} step={step} busy={busy} /> : null}
        </div>
    );
}
