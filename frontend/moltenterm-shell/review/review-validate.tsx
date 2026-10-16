// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Validate (FR-REV-012, DS-REV-010): the Review tab's header button and its sheet. The sheet is a stepper in the order
// things happen (#672): before the merge it is the plan, each step saying what it will do, bound to the head it read;
// Merge is the only way to start it (NFR-REV-003), and the merge's progress and the cleanup's outcome then fill the same
// steps from the review store.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { ReviewsModel } from "../reviews/reviews-store";
import { SegmentedControl } from "../segmented-control";
import { DominoLoader } from "../suite/suite";
import { cleanupLeftovers, cleanupNeedsConfirmation, ReviewCleanupResult } from "./review-cleanup";
import { ReviewMergeMethod, ReviewMergePlan, ReviewMergeRecord } from "./review-client";
import { mergedFooter } from "./review-done";
import { MergedFooterButtons } from "./review-done-view";
import {
    canCancelMerge,
    canClickMerge,
    chosenMethod,
    mergeButtonLabel,
    mergeCleanup,
    mergeDisabledReason,
    mergeRunning,
    sheetRecord,
    validateErrorText,
} from "./review-merge";
import { shortOid } from "./review-model";
import { buildValidateSteps } from "./review-stepper";
import { ValidateStepper } from "./review-stepper-view";
import { DraftActions } from "./review-tab-draft";
import { ReviewTabModel } from "./review-tab-model";
import { ReviewValidateModel } from "./review-validate-model";

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

export function ValidateButton({ model }: { model: ReviewTabModel }) {
    const t = useT();
    const state = useAtomValue(model.stateAtom);
    const draft = useAtomValue(model.draftAtom);
    const running = mergeRunning(state?.merge);
    if (draft && !running) {
        return <DraftActions model={model} />;
    }
    return (
        <button
            type="button"
            className="molten-btn flex h-6 cursor-pointer items-center gap-1.5 rounded-6 px-2 text-12"
            onClick={() => fireAndForget(() => model.openValidate())}
            title={t("review.validate.buttonTitle")}
            data-testid="review-validate"
        >
            {running ? <DominoLoader /> : <i className="fa fa-solid fa-code-merge text-11" />}
            {running ? t("review.merge.state.merging") : t("review.validate.button")}
            <MoltenWave />
        </button>
    );
}

export function ValidateSheet({ model }: { model: ReviewValidateModel }) {
    const t = useT();
    const v = useAtomValue(model.validateAtom);
    const pr = useAtomValue(model.prAtom);
    const state = useAtomValue(model.stateAtom);
    const storedCleanup = state?.cleanup;
    useEffect(() => {
        ReviewsModel.getInstance().noteCleanupRebases(pr?.dir, storedCleanup);
    }, [pr?.dir, storedCleanup]);
    if (!v.open || pr == null) {
        return null;
    }
    const plan = v.plan;
    // Reopened from the Validated state (#686), the sheet shows the merge as the store has it.
    const record = v.result ? (state?.merge ?? null) : sheetRecord(state?.merge, v.clicked ?? null);
    const baseref = plan?.baseref ?? pr.baseref;
    const method = chosenMethod(plan, v.method);
    const enabled = canClickMerge(plan, v.override, state?.merge) && record == null && v.clicked == null;
    const disabledReason = mergeDisabledReason(plan, v.override, state?.merge);
    const cleanup: ReviewCleanupResult = record != null ? mergeCleanup(record, state?.cleanup) : null;
    const steps = buildValidateSteps(t, { plan, record, cleanup, headref: pr.headref, baseref, method });
    const locked = record != null || v.clicked != null;
    const keptAgent = cleanupNeedsConfirmation(cleanup?.steps);
    const keptReview = cleanup?.steps?.find(
        (s) => s.id === "review-worktree" && (s.code === "kept" || s.code === "inuse")
    );
    const warnings = plan?.warnings ?? [];
    // Merged from a Reviews row (#707): closing the sheet loses nothing, so a press outside is Done.
    const backdropDone = !model.host.inTab && mergedFooter(record, cleanup) != null;
    return (
        <DialogFrame
            role="review-validate"
            onEscape={v.open ? () => model.closeValidate() : undefined}
            title={t("review.validate.title", { number: pr.number })}
            subtitle={t("review.validate.subtitle", { head: pr.headref, base: baseref })}
            widthClass="w-[640px]"
            trapFocus
            suite
            onBackdrop={backdropDone ? () => model.closeValidate() : undefined}
            buttons={
                <SheetButtons
                    model={model}
                    plan={plan}
                    record={record}
                    cleanup={cleanup}
                    method={method}
                    enabled={enabled}
                    disabledReason={disabledReason}
                    loading={v.loading}
                />
            }
        >
            <div className="flex flex-col gap-3 pt-4" data-testid="validate-plan">
                {v.error ? (
                    <div
                        className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 break-words text-danger"
                        data-testid="validate-error"
                    >
                        {validateErrorText(v.error)}
                    </div>
                ) : null}
                <ValidateStepper
                    steps={steps}
                    mergeTop={
                        !locked && !plan?.queue && (plan?.methods?.length ?? 0) > 1 ? (
                            <MethodPicker plan={plan} method={method} onSelect={(m) => model.setValidateMethod(m)} />
                        ) : null
                    }
                    checksExtra={
                        warnings.length > 0 && record == null ? (
                            <label
                                className={cn(
                                    "mt-2 flex items-start gap-2 rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5",
                                    locked ? "opacity-60" : "cursor-pointer"
                                )}
                            >
                                <input
                                    type="checkbox"
                                    className="mt-0.5 cursor-pointer"
                                    checked={v.override}
                                    disabled={locked}
                                    onChange={(e) => model.setValidateOverride(e.target.checked)}
                                    data-testid="validate-override"
                                />
                                <span>{t("review.validate.mergeAnyway")}</span>
                            </label>
                        ) : null
                    }
                    kept={{
                        steps: [keptReview, keptAgent, ...cleanupLeftovers(cleanup?.steps)],
                        busy: v.confirming,
                        onRemove: (step) => fireAndForget(() => model.removeKeptWorktree(step)),
                        onRemoveLeftover: (step) => fireAndForget(() => model.removeLeftover(step)),
                    }}
                    onStartAgent={(other) =>
                        ReviewsModel.getInstance().startCleanupAgent(
                            pr.dir,
                            pr.repo,
                            cleanup?.base || baseref,
                            other,
                            pr.number
                        )
                    }
                />
                {record == null && plan != null && !plan.canmerge ? (
                    <div className="text-danger" data-testid="validate-reason">
                        {t("review.validate.mergeDisabled", { reason: disabledReason })}
                    </div>
                ) : null}
            </div>
        </DialogFrame>
    );
}

function SheetButtons({
    model,
    plan,
    method,
    record,
    cleanup,
    enabled,
    disabledReason,
    loading,
}: {
    model: ReviewValidateModel;
    plan: ReviewMergePlan;
    record: ReviewMergeRecord;
    cleanup: ReviewCleanupResult;
    method: ReviewMergeMethod;
    enabled: boolean;
    disabledReason: string;
    loading: boolean;
}) {
    const t = useT();
    if (record != null && record.state === "refused" && record.refused === "headmoved") {
        return (
            <>
                <button type="button" className={PlainButton} onClick={() => model.closeValidate()}>
                    {t("common.close")}
                </button>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                    onClick={() => fireAndForget(() => model.reviewNewCommits())}
                    data-testid="validate-review-new"
                >
                    {t("review.validate.reviewNewCommits")}
                    <MoltenWave />
                </button>
            </>
        );
    }
    const footer = mergedFooter(record, cleanup);
    if (footer != null) {
        return <MergedFooterButtons model={model} footer={footer} plainClass={PlainButton} />;
    }
    if (record != null) {
        const ended = !mergeRunning(record);
        return (
            <>
                {canCancelMerge(record) ? (
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => fireAndForget(() => model.cancelMerge())}
                        data-testid="validate-cancel"
                    >
                        {t("review.validate.stopWaiting")}
                    </button>
                ) : null}
                {ended && record.state !== "merged" ? (
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => fireAndForget(() => model.openValidate())}
                        data-testid="validate-again"
                    >
                        {t("review.validate.again")}
                    </button>
                ) : null}
                <button type="button" className={PlainButton} onClick={() => model.closeValidate()}>
                    {t("common.close")}
                </button>
            </>
        );
    }
    return (
        <>
            <button
                type="button"
                className={cn(PlainButton, "mr-auto")}
                disabled={loading}
                onClick={() => fireAndForget(() => model.loadPlan())}
                title={t("review.validate.recheckTitle")}
                data-testid="validate-recheck"
            >
                <i className="fa fa-solid fa-rotate mr-1 text-11" />
                {t("review.validate.recheck")}
            </button>
            <button type="button" className={PlainButton} onClick={() => model.closeValidate()}>
                {t("common.cancel")}
            </button>
            <button
                type="button"
                className="molten-btn flex cursor-pointer items-center gap-1.5 rounded-4 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-50"
                disabled={!enabled}
                title={enabled ? t("review.validate.mergeTitle", { oid: shortOid(plan?.headoid) }) : disabledReason}
                onClick={() => fireAndForget(() => model.merge())}
                data-testid="validate-merge"
            >
                <i className="fa fa-solid fa-code-merge text-11" />
                {mergeButtonLabel(plan, method)}
                <MoltenWave />
            </button>
        </>
    );
}

// The merge method (#673): only the ones the repository and the base's rules allow, the last one used preselected.
function MethodPicker({
    plan,
    method,
    onSelect,
}: {
    plan: ReviewMergePlan;
    method: ReviewMergeMethod;
    onSelect: (method: ReviewMergeMethod) => void;
}) {
    const t = useT();
    const segments = (plan.methods ?? []).map((m) => ({
        value: m,
        label: t(`review.validate.method.${m}`),
        title: t(`review.validate.methodTitle.${m}`),
    }));
    return (
        <div className="mt-1 mb-1 flex items-center gap-2" data-testid="validate-method">
            <span className="text-12 text-secondary">{t("review.validate.methodLabel")}</span>
            <SegmentedControl
                label={t("review.validate.methodLabel")}
                segments={segments}
                selected={method}
                onSelect={onSelect}
            />
        </div>
    );
}
