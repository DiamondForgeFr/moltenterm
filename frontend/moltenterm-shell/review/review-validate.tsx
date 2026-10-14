// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Validate (FR-REV-012, DS-REV-010): the Review tab's header button and its plan sheet. The sheet shows what the merge
// checked and what it will do, bound to the head it read; Merge is the only way to start it (NFR-REV-003), and the
// merge's progress and outcome come back from the review store.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { DialogFrame, useEscape } from "../dialog-frame";
import { MoltenWave } from "../molten-button";
import { ReviewCleanupResult } from "./review-cleanup";
import { CleanupSteps } from "./review-cleanup-steps";
import { ReviewMergeCheck, ReviewMergePlan, ReviewMergeRecord } from "./review-client";
import {
    canCancelMerge,
    canClickMerge,
    CheckLooks,
    mergeButtonLabel,
    mergeCleanup,
    mergeDisabledReason,
    mergeRunning,
    mergeStateLabel,
    mergeStateTone,
    sheetRecord,
} from "./review-merge";
import { shortOid } from "./review-model";
import { ReviewTabModel } from "./review-tab-model";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

export function ValidateButton({ model }: { model: ReviewTabModel }) {
    const state = useAtomValue(model.stateAtom);
    const running = mergeRunning(state?.merge);
    return (
        <button
            type="button"
            className="molten-btn flex h-6 cursor-pointer items-center gap-1.5 rounded-6 px-2 text-12"
            onClick={() => fireAndForget(() => model.openValidate())}
            title="Rebase and merge this pull request: shows the plan first"
            data-testid="review-validate"
        >
            {running ? (
                <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin text-11" />
            ) : (
                <i className="fa fa-solid fa-code-merge text-11" />
            )}
            {running ? "Merging…" : "Validate"}
            <MoltenWave />
        </button>
    );
}

export function ValidateSheet({ model }: { model: ReviewTabModel }) {
    const v = useAtomValue(model.validateAtom);
    const pr = useAtomValue(model.prAtom);
    const state = useAtomValue(model.stateAtom);
    useEscape(v.open, () => model.closeValidate());
    if (!v.open || pr == null) {
        return null;
    }
    const plan = v.plan;
    const record = sheetRecord(state?.merge, v.clicked ?? null);
    const baseref = plan?.baseref ?? pr.baseref;
    const enabled = canClickMerge(plan, v.override, state?.merge) && record == null && v.clicked == null;
    const disabledReason = mergeDisabledReason(plan, v.override, state?.merge);
    return (
        <DialogFrame
            role="review-validate"
            title={`Validate #${pr.number}`}
            subtitle={`Rebase and merge ${pr.headref} into ${baseref}`}
            widthClass="w-[640px]"
            trapFocus
            buttons={
                <SheetButtons
                    model={model}
                    plan={plan}
                    record={record}
                    enabled={enabled}
                    disabledReason={disabledReason}
                    loading={v.loading}
                />
            }
        >
            {v.error ? (
                <div
                    className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-error"
                    data-testid="validate-error"
                >
                    {v.error}
                </div>
            ) : null}
            {record != null ? (
                <MergeProgress
                    model={model}
                    record={record}
                    cleanup={mergeCleanup(record, state?.cleanup)}
                    confirming={v.confirming}
                    baseref={baseref}
                />
            ) : null}
            {plan == null && v.loading ? (
                <div className="flex items-center gap-2 text-muted">
                    <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin text-11" />
                    Reading the pull request on GitHub…
                </div>
            ) : null}
            {plan != null ? (
                <PlanBody
                    plan={plan}
                    override={v.override}
                    onOverride={(o) => model.setValidateOverride(o)}
                    locked={record != null || v.clicked != null}
                    disabledReason={record == null ? disabledReason : ""}
                />
            ) : null}
        </DialogFrame>
    );
}

function SheetButtons({
    model,
    plan,
    record,
    enabled,
    disabledReason,
    loading,
}: {
    model: ReviewTabModel;
    plan: ReviewMergePlan;
    record: ReviewMergeRecord;
    enabled: boolean;
    disabledReason: string;
    loading: boolean;
}) {
    if (record != null && record.state === "refused" && record.refused === "headmoved") {
        return (
            <>
                <button type="button" className={PlainButton} onClick={() => model.closeValidate()}>
                    Close
                </button>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1 text-12"
                    onClick={() => fireAndForget(() => model.reviewNewCommits())}
                    data-testid="validate-review-new"
                >
                    Review the new commits
                    <MoltenWave />
                </button>
            </>
        );
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
                        Stop waiting
                    </button>
                ) : null}
                {ended && record.state !== "merged" ? (
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => fireAndForget(() => model.openValidate())}
                        data-testid="validate-again"
                    >
                        Validate again
                    </button>
                ) : null}
                <button type="button" className={PlainButton} onClick={() => model.closeValidate()}>
                    Close
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
                title="Read the pull request again"
                data-testid="validate-recheck"
            >
                <i className="fa fa-solid fa-rotate mr-1 text-11" />
                Re-check
            </button>
            <button type="button" className={PlainButton} onClick={() => model.closeValidate()}>
                Cancel
            </button>
            <button
                type="button"
                className="molten-btn flex cursor-pointer items-center gap-1.5 rounded-6 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-50"
                disabled={!enabled}
                title={enabled ? `Merge, bound to head ${shortOid(plan?.headoid)}` : disabledReason}
                onClick={() => fireAndForget(() => model.merge())}
                data-testid="validate-merge"
            >
                <i className="fa fa-solid fa-code-merge text-11" />
                {mergeButtonLabel(plan)}
                <MoltenWave />
            </button>
        </>
    );
}

function PlanBody({
    plan,
    override,
    onOverride,
    locked,
    disabledReason,
}: {
    plan: ReviewMergePlan;
    override: boolean;
    onOverride: (override: boolean) => void;
    locked: boolean;
    disabledReason: string;
}) {
    const warnings = plan.warnings ?? [];
    return (
        <div className="flex flex-col gap-3" data-testid="validate-plan">
            <div className="text-muted">
                Planned on head <code title={plan.headoid}>{shortOid(plan.headoid)}</code>: anything pushed after this
                plan makes the merge refuse.
            </div>
            <section>
                <div className="mb-1.5 font-medium text-muted">Checks</div>
                <div className="flex flex-col gap-1">
                    {plan.checks.map((c) => (
                        <CheckRow key={c.id} check={c} />
                    ))}
                </div>
            </section>
            {warnings.length > 0 ? (
                <label
                    className={cn(
                        "flex items-start gap-2 rounded-6 border border-warning/40 bg-warning/10 px-2 py-1.5",
                        locked ? "opacity-60" : "cursor-pointer"
                    )}
                >
                    <input
                        type="checkbox"
                        className="mt-0.5 cursor-pointer"
                        checked={override}
                        disabled={locked}
                        onChange={(e) => onOverride(e.target.checked)}
                        data-testid="validate-override"
                    />
                    <span>Merge anyway: I have read the warnings above.</span>
                </label>
            ) : null}
            <section>
                <div className="mb-1.5 font-medium text-muted">Steps</div>
                <ol className="flex list-decimal flex-col gap-1 pl-5">
                    {plan.steps.map((s) => (
                        <li key={s.id} data-testid={`validate-step-${s.id}`}>
                            <span className="text-primary">{s.label}</span>
                            {s.detail ? <div className="text-muted">{s.detail}</div> : null}
                        </li>
                    ))}
                </ol>
            </section>
            {plan.cleanup.length > 0 && !locked ? (
                <section data-testid="validate-cleanup-plan">
                    <div className="mb-1.5 font-medium text-muted">Then the cleanup</div>
                    <CleanupSteps steps={plan.cleanup} />
                </section>
            ) : null}
            {disabledReason && !plan.canmerge ? (
                <div className="text-error" data-testid="validate-reason">
                    Merge is disabled: {disabledReason}
                </div>
            ) : null}
        </div>
    );
}

function CheckRow({ check }: { check: ReviewMergeCheck }) {
    const look = CheckLooks[check.state] ?? CheckLooks.pending;
    return (
        <div className="flex items-start gap-2" data-testid={`validate-check-${check.id}`} data-state={check.state}>
            <i className={cn("fa fa-solid mt-0.5 w-3.5 text-11", look.icon, look.tone)} title={look.word} />
            <div className="min-w-0">
                <div className="text-primary">{check.label}</div>
                {check.detail ? <div className="text-muted">{check.detail}</div> : null}
            </div>
        </div>
    );
}

function MergeProgress({
    model,
    record,
    cleanup,
    confirming,
    baseref,
}: {
    model: ReviewTabModel;
    record: ReviewMergeRecord;
    cleanup: ReviewCleanupResult;
    confirming: boolean;
    baseref: string;
}) {
    const running = mergeRunning(record);
    return (
        <div
            className="flex flex-col gap-1.5 rounded-6 border border-border px-3 py-2"
            data-testid="validate-progress"
            data-state={record.state}
        >
            <div className={cn("flex items-center gap-2 text-13 leading-5", mergeStateTone(record.state))}>
                {running ? <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin text-11" /> : null}
                <span>{mergeStateLabel(record, baseref)}</span>
            </div>
            {record.head && record.head !== record.planhead ? (
                <div className="text-muted">
                    Rebased by GitHub: head <code title={record.head}>{shortOid(record.head)}</code>
                </div>
            ) : null}
            {record.cleanuprunning || cleanup != null ? (
                <div className="mt-1 flex flex-col gap-1" data-testid="validate-cleanup">
                    <div className="flex items-center gap-2 font-medium text-muted">
                        {record.cleanuprunning ? (
                            <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin text-11" />
                        ) : null}
                        {record.cleanuprunning ? "Cleaning up after the merge…" : "Cleanup"}
                    </div>
                    {cleanup != null ? (
                        <CleanupSteps
                            steps={cleanup.steps}
                            busy={confirming}
                            onConfirmWorktree={(risk) => fireAndForget(() => model.confirmCleanupWorktree(risk))}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
