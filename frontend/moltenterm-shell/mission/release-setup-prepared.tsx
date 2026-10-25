// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 3 of the pipeline setup, "Prepare and validate" (#1104, FR-MC-038): the prepared pipeline drawn as it will run,
// its exact changes file by file (with the checks and the formatter the draft proposes, each one dropped by a tick),
// the agent's proposals in context (#1099), the commands that will ask for trust, and the validation by a pull request
// from a worktree of MoltenTerm's own (#1098), followed in the step until it is merged. Nothing is written before
// "Open the pull request".

import { cn, fireAndForget } from "@/util/util";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";
import { DiffView } from "./release-setup";
import { setupPrStatus } from "./release-setup-client";
import { FlowDiagram } from "./release-setup-diagram";
import {
    flowModel,
    SetupChannel,
    SetupDraft,
    SetupOptions,
    SetupPrJob,
    SetupProposalResult,
    SetupSource,
    SetupTicketChoice,
} from "./release-setup-model";
import { PrPanel } from "./release-setup-pr";
import {
    diffCounts,
    markFlow,
    newCommands,
    pipelineDiff,
    preparedDraft,
    PreparedFieldChange,
    PreparedFile,
    preparedFiles,
    PreparedPipelineDiff,
    PreparedStepChange,
    prFollowDone,
    prFollowKey,
    proposedChecks,
    proposesFormat,
    SetupPrStatus,
    toggledCheck,
} from "./release-setup-prepared-model";
import { AgentProposal } from "./release-setup-proposal";
import { FlowReasons } from "./release-setup-reasons";
import { techDocFile, useTechDocPlan } from "./release-setup-techdoc";

const BlockClass = "flex min-w-0 flex-col gap-2 rounded-6 border border-border p-3";
const ChipClass = "self-start rounded-4 border border-accent/50 px-1.5 text-11 leading-5 text-accent";
const SmallButton =
    "cursor-pointer rounded-4 border border-border px-2 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const FollowMs = 15000;

// The versions fields the list names in words; any other one shows its key.
const KnownFields = new Set([
    "versions.format",
    "versions.files",
    "versions.tagprefix",
    "versions.notes",
    "versions.changelogs",
    "versions.firstpublic",
    "branches",
    "steps",
]);

function KindPill({ kind }: { kind: "added" | "changed" | "removed" }) {
    const t = useT();
    return (
        <span
            className={cn(
                "shrink-0 rounded-full border px-1.5 text-11 leading-4",
                kind === "added" && "border-success/50 text-success",
                kind === "changed" && "border-warning/50 text-warning",
                kind === "removed" && "border-error/50 text-danger"
            )}
        >
            {t(`mc.setup.prepared.kind.${kind}`)}
        </span>
    );
}

function BeforeAfter({ before, after }: { before?: string; after?: string }) {
    const t = useT();
    return (
        <div className="grid gap-2 @min-[40rem]:grid-cols-2">
            {before ? (
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-11 text-muted uppercase">{t("mc.setup.prepared.before")}</span>
                    <pre className="overflow-auto rounded-4 bg-black/30 p-2 font-mono text-11 whitespace-pre-wrap text-secondary">
                        {before}
                    </pre>
                </div>
            ) : null}
            {after ? (
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-11 text-muted uppercase">{t("mc.setup.prepared.after")}</span>
                    <pre className="overflow-auto rounded-4 bg-black/30 p-2 font-mono text-11 whitespace-pre-wrap text-secondary">
                        {after}
                    </pre>
                </div>
            ) : null}
        </div>
    );
}

function Toggle({
    on,
    disabled,
    label,
    onChange,
    testId,
}: {
    on: boolean;
    disabled: boolean;
    label: string;
    onChange: (on: boolean) => void;
    testId: string;
}) {
    return (
        <input
            type="checkbox"
            className="mt-0.5 cursor-pointer"
            checked={on}
            disabled={disabled}
            aria-label={label}
            onChange={(e) => onChange(e.target.checked)}
            data-testid={testId}
        />
    );
}

function StepRow({
    change,
    checkProposed,
    locked,
    onCheck,
}: {
    change: PreparedStepChange;
    checkProposed: boolean;
    locked: boolean;
    onCheck: (on: boolean) => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    return (
        <li
            className="flex flex-col gap-1 border-t border-border px-2.5 py-2"
            data-testid={`prepared-step-${change.key}`}
        >
            <div className="flex flex-wrap items-center gap-2">
                <KindPill kind={change.kind} />
                <span className="text-11 text-muted">{t(`mc.setup.flow.${change.channel}`)}</span>
                <span className="min-w-0 flex-1 text-12 text-primary wrap-anywhere">{change.title}</span>
                <button
                    type="button"
                    className="cursor-pointer text-11 text-muted hover:text-primary"
                    onClick={() => setOpen(!open)}
                >
                    {open ? t("mc.setup.prepared.hide") : t("mc.setup.prepared.show")}
                </button>
            </div>
            {change.kind === "removed" ? null : (
                <p className="text-11 text-muted wrap-anywhere">
                    {change.manual ? (
                        t("mc.setup.prepared.byHand")
                    ) : (
                        <>
                            {t("mc.setup.prepared.runs")} <code className="font-mono text-secondary">{change.run}</code>
                        </>
                    )}
                </p>
            )}
            {change.kind !== "removed" && change.check ? (
                <label
                    className={cn("flex items-start gap-2 text-11", locked ? "" : "cursor-pointer")}
                    data-testid={`prepared-check-${change.key}`}
                >
                    {checkProposed ? (
                        <Toggle
                            on
                            disabled={locked}
                            label={t("mc.setup.prepared.checkToggle", { title: change.title })}
                            onChange={onCheck}
                            testId={`prepared-check-toggle-${change.id}`}
                        />
                    ) : null}
                    <span className="text-secondary wrap-anywhere">
                        {t("mc.setup.prepared.check", { path: change.check.path, contains: change.check.contains })}
                        {checkProposed ? (
                            <span className="ml-1 text-muted">{t("mc.setup.prepared.checkProposed")}</span>
                        ) : null}
                    </span>
                </label>
            ) : null}
            {open ? <BeforeAfter before={change.before} after={change.after} /> : null}
        </li>
    );
}

function fieldLabel(t: (key: string, vars?: Record<string, string>) => string, change: PreparedFieldChange): string {
    if (KnownFields.has(change.key)) {
        return t(`mc.setup.prepared.field.${change.key.split(".").pop()}`);
    }
    return change.key;
}

function FieldRow({
    change,
    formatProposed,
    locked,
    onFormat,
}: {
    change: PreparedFieldChange;
    formatProposed: boolean;
    locked: boolean;
    onFormat: (on: boolean) => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const isFormat = change.key === "versions.format";
    const inline = change.key === "versions.files" || isFormat;
    const value = change.after ?? change.before;
    return (
        <li
            className="flex flex-col gap-1 border-t border-border px-2.5 py-2"
            data-testid={`prepared-field-${change.key}`}
        >
            <div className="flex flex-wrap items-center gap-2">
                {isFormat && formatProposed ? (
                    <Toggle
                        on
                        disabled={locked}
                        label={t("mc.setup.prepared.formatToggle")}
                        onChange={onFormat}
                        testId="prepared-format-toggle"
                    />
                ) : null}
                <KindPill kind={change.kind} />
                {change.key.startsWith("versions.") ? (
                    <span className="text-11 text-muted">{t("mc.setup.prepared.versions")}</span>
                ) : null}
                <span className="min-w-0 flex-1 text-12 text-primary">{fieldLabel(t, change)}</span>
                {inline ? null : (
                    <button
                        type="button"
                        className="cursor-pointer text-11 text-muted hover:text-primary"
                        onClick={() => setOpen(!open)}
                    >
                        {open ? t("mc.setup.prepared.hide") : t("mc.setup.prepared.show")}
                    </button>
                )}
            </div>
            {inline ? (
                <code className="font-mono text-11 wrap-anywhere text-secondary">
                    {isFormat ? JSON.parse(value ?? '""') : value}
                </code>
            ) : null}
            {isFormat && formatProposed ? (
                <p className="text-11 text-muted">{t("mc.setup.prepared.formatWhy")}</p>
            ) : null}
            {open ? <BeforeAfter before={change.before} after={change.after} /> : null}
        </li>
    );
}

// A proposal the developer dropped, kept in the list with its tick to take it back.
function DroppedRow({
    label,
    locked,
    onTake,
    testId,
}: {
    label: string;
    locked: boolean;
    onTake: () => void;
    testId: string;
}) {
    return (
        <li
            className="flex items-start gap-2 border-t border-border px-2.5 py-2 text-11 text-muted"
            data-testid={testId}
        >
            <Toggle on={false} disabled={locked} label={label} onChange={onTake} testId={`${testId}-toggle`} />
            <span>{label}</span>
        </li>
    );
}

function PipelineFileCard({
    file,
    draft,
    options,
    proposed,
    diff,
    locked,
    onOptions,
}: {
    file: PreparedFile;
    draft: SetupDraft;
    options: SetupOptions;
    proposed: string;
    diff: PreparedPipelineDiff;
    locked: boolean;
    onOptions: (o: SetupOptions) => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const [whole, setWhole] = useState(diff == null);
    const counts = diffCounts(diff);
    const checks = proposedChecks(draft, options);
    const format = proposesFormat(draft, options);
    const dropped = (options.nocheck ?? []).filter((id) => checks.includes(id));
    return (
        <div className="flex flex-col rounded-4 border border-border" data-testid="prepared-file-pipeline">
            <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
                <code className="font-mono text-12 text-primary">{file.path}</code>
                <StatusPill status={file.status} />
                {counts.added > 0 ? (
                    <span className="rounded-full border border-success/50 px-1.5 text-11 leading-4 text-success">
                        {tCount("mc.setup.prepared.countAdded", counts.added)}
                    </span>
                ) : null}
                {counts.changed > 0 ? (
                    <span className="rounded-full border border-warning/50 px-1.5 text-11 leading-4 text-warning">
                        {tCount("mc.setup.prepared.countChanged", counts.changed)}
                    </span>
                ) : null}
                {counts.removed > 0 ? (
                    <span className="rounded-full border border-error/50 px-1.5 text-11 leading-4 text-danger">
                        {tCount("mc.setup.prepared.countRemoved", counts.removed)}
                    </span>
                ) : null}
                {diff?.untouched.length > 0 ? (
                    <span
                        className="rounded-full border border-border px-1.5 text-11 leading-4 text-muted"
                        data-testid="prepared-untouched"
                    >
                        {t("mc.setup.prepared.untouched", { keys: diff.untouched.join(", ") })}
                    </span>
                ) : null}
                <button
                    type="button"
                    className={cn(SmallButton, "ml-auto")}
                    onClick={() => setWhole(!whole)}
                    data-testid="prepared-whole-diff"
                >
                    {whole ? t("mc.setup.prepared.hideWhole") : t("mc.setup.prepared.whole")}
                </button>
            </div>
            {diff == null ? (
                <p className="px-2.5 pb-2 text-11 text-warning">{t("mc.setup.prepared.unreadable")}</p>
            ) : null}
            {diff != null ? (
                <ul className="flex flex-col">
                    {diff.steps.map((c) => (
                        <StepRow
                            key={c.key}
                            change={c}
                            checkProposed={checks.includes(c.id) && !(options.nocheck ?? []).includes(c.id)}
                            locked={locked}
                            onCheck={(on) => onOptions(toggledCheck(options, c.id, on))}
                        />
                    ))}
                    {dropped.map((id) => (
                        <DroppedRow
                            key={`nocheck-${id}`}
                            label={t("mc.setup.prepared.checkDropped", { id })}
                            locked={locked}
                            onTake={() => onOptions(toggledCheck(options, id, true))}
                            testId={`prepared-check-dropped-${id}`}
                        />
                    ))}
                    {diff.fields.map((c, i) => (
                        <FieldRow
                            key={`${c.key}-${i}`}
                            change={c}
                            formatProposed={format && !options.noformat}
                            locked={locked}
                            onFormat={(on) => onOptions({ ...options, noformat: !on })}
                        />
                    ))}
                    {format && options.noformat ? (
                        <DroppedRow
                            label={t("mc.setup.prepared.formatDropped")}
                            locked={locked}
                            onTake={() => onOptions({ ...options, noformat: false })}
                            testId="prepared-format-dropped"
                        />
                    ) : null}
                    {diff.steps.length === 0 && diff.fields.length === 0 ? (
                        <li className="border-t border-border px-2.5 py-2 text-11 text-muted">
                            {t("mc.setup.prepared.noChange")}
                        </li>
                    ) : null}
                </ul>
            ) : null}
            {locked && (checks.length > 0 || format) ? (
                <p className="border-t border-border px-2.5 py-1.5 text-11 text-muted">
                    {t("mc.setup.prepared.lockedHint")}
                </p>
            ) : null}
            {whole ? (
                <div className="border-t border-border p-2">
                    <DiffView before={draft.current} after={proposed} />
                </div>
            ) : null}
        </div>
    );
}

function StatusPill({ status }: { status: PreparedFile["status"] }) {
    const t = useT();
    return (
        <span
            className={cn(
                "rounded-full border px-1.5 text-11 leading-4",
                status === "new" ? "border-success/50 text-success" : "border-warning/50 text-warning"
            )}
        >
            {t(`mc.setup.prepared.status.${status}`)}
        </span>
    );
}

function OtherFileCard({ file }: { file: PreparedFile }) {
    const t = useT();
    const [open, setOpen] = useState(file.kind === "whole" && !file.collapsed);
    return (
        <div className="flex flex-col rounded-4 border border-border" data-testid={`prepared-file-${file.kind}`}>
            <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
                <code className="font-mono text-12 text-primary">{file.path}</code>
                <StatusPill status={file.status} />
                {file.kind === "whole" && file.content != null ? (
                    <button type="button" className={cn(SmallButton, "ml-auto")} onClick={() => setOpen(!open)}>
                        {open ? t("mc.setup.prepared.hide") : t("mc.setup.prepared.show")}
                    </button>
                ) : null}
            </div>
            <p className="px-2.5 pb-2 text-11 text-muted">
                {file.kind === "record"
                    ? t("mc.setup.prepared.recordWhy")
                    : t(file.introKey ?? "", {
                          ...file.introVars,
                          targets: (file.targets ?? []).map((id) => t(`mc.setup.describe.target.${id}`)).join(", "),
                      })}
            </p>
            {file.warningKey ? (
                <p className="px-2.5 pb-2 text-11 text-warning">{t(file.warningKey, file.warningVars)}</p>
            ) : null}
            {open && file.content != null ? (
                <div className="border-t border-border p-2">
                    <DiffView before={file.before ?? ""} after={file.content} />
                </div>
            ) : null}
        </div>
    );
}

function CommandsBlock({ current, proposed }: { current: string; proposed: string }) {
    const t = useT();
    const commands = useMemo(() => newCommands(current, proposed), [current, proposed]);
    return (
        <div className={BlockClass} data-testid="prepared-commands">
            <span className={ChipClass}>{t("mc.setup.prepared.commandsTitle")}</span>
            <p className="text-11 text-muted">{t("mc.setup.prepared.commandsDesc")}</p>
            {commands.length === 0 ? (
                <p className="text-11 text-secondary">{t("mc.setup.prepared.commandsNone")}</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {commands.map((c) => (
                        <li key={c.run} className="flex flex-col gap-0.5" data-testid="prepared-command">
                            <code className="rounded-4 bg-black/30 px-2 py-1 font-mono text-11 wrap-anywhere text-primary">
                                {c.run}
                            </code>
                            <span className="text-10 text-muted">{c.places.join(", ")}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// Follows the pull request the job opened until it is merged or closed.
export function usePrFollow(dir: string, job: SetupPrJob): { status: SetupPrStatus; error: boolean } {
    const [status, setStatus] = useState<SetupPrStatus>(null);
    const [error, setError] = useState(false);
    const number = job?.finished && job.failure == null && job.mode === "pr" ? job.prnumber : 0;
    useEffect(() => {
        if (!(number > 0)) {
            setStatus(null);
            return;
        }
        let live = true;
        let timer: ReturnType<typeof setTimeout> = null;
        const read = () =>
            fireAndForget(async () => {
                let next: SetupPrStatus = null;
                try {
                    next = await setupPrStatus(dir, number);
                    if (live) {
                        setStatus(next);
                        setError(false);
                    }
                } catch {
                    if (live) {
                        setError(true);
                    }
                }
                if (live && !prFollowDone(next)) {
                    timer = setTimeout(read, FollowMs);
                }
            });
        read();
        return () => {
            live = false;
            if (timer != null) {
                clearTimeout(timer);
            }
        };
    }, [dir, number]);
    return { status, error };
}

export function PrFollow({
    dir,
    job,
    status,
    error,
    onOpenReviews,
}: {
    dir: string;
    job: SetupPrJob;
    status: SetupPrStatus;
    error: boolean;
    onOpenReviews: (dir: string, number: number) => void;
}) {
    const t = useT();
    if (!(job?.prnumber > 0) || job.failure != null || !job.finished) {
        return null;
    }
    const number = String(job.prnumber);
    const tone =
        status == null
            ? "text-muted"
            : status.state === "merged" || (status.state === "open" && status.checks === "success")
              ? "text-success"
              : status.state === "closed" || status.checks === "failure"
                ? "text-danger"
                : "text-secondary";
    return (
        <div
            className={BlockClass}
            data-testid="prepared-follow"
            data-state={status?.state ?? ""}
            data-checks={status?.checks ?? ""}
        >
            <span className={ChipClass}>{t("mc.setup.prepared.followTitle", { number })}</span>
            <p className={cn("text-12", tone)} data-testid="prepared-follow-line">
                {status == null
                    ? t("mc.setup.prepared.follow.reading", { number })
                    : t(prFollowKey(status), {
                          number,
                          target: status.base || job.target,
                          failed: String(status.failure),
                          pending: String(status.pending),
                          success: String(status.success),
                      })}
            </p>
            {error ? <p className="text-11 text-warning">{t("mc.setup.prepared.follow.unread")}</p> : null}
            <div className="flex flex-wrap gap-1.5">
                <button
                    type="button"
                    className={SmallButton}
                    onClick={() => onOpenReviews(dir, job.prnumber)}
                    data-testid="prepared-open-reviews"
                >
                    {t("mc.setup.prepared.openReviews", { number })}
                </button>
                {job.prurl ? (
                    <button
                        type="button"
                        className={SmallButton}
                        onClick={() => fireAndForget(() => openWebLink(job.prurl))}
                    >
                        {t("mc.setup.prepared.openGithub")}
                        <i className="fa fa-solid fa-arrow-up-right-from-square ml-1 text-10" />
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function Sources({ draft }: { draft: SetupDraft }) {
    const t = useT();
    const sources = Object.entries(draft.proposal.sources ?? {});
    const text = (source: SetupSource) =>
        source?.code
            ? t(`mc.setup.source.${source.code}`, { path: source.path ?? "", detail: source.detail ?? "" })
            : "";
    if (sources.length === 0) {
        return null;
    }
    return (
        <details className="rounded-6 border border-border px-3 py-2 text-11 text-secondary">
            <summary className="cursor-pointer text-12 text-primary">{t("mc.setup.review.sources")}</summary>
            <ul className="mt-1 flex flex-col gap-0.5" data-testid="setup-sources">
                {sources.map(([key, source]) => (
                    <li key={key} className="wrap-anywhere">
                        <span className="font-mono text-muted">{key}</span> · {text(source)}
                    </li>
                ))}
            </ul>
        </details>
    );
}

// The validation block's own props, handed through to #1098's panel.
export type PreparedPrProps = {
    ticket: SetupTicketChoice;
    onTicket: (choice: SetupTicketChoice) => void;
    job: SetupPrJob;
    busy: boolean;
    error: string;
    onAgain: () => void;
    onOpenReviews: (dir: string, number: number) => void;
};

export function PreparedStep({
    dir,
    draft,
    options,
    refined,
    onRefined,
    onRefining,
    onOptions,
    extraFiles,
    initialRequest,
    pr,
}: {
    dir: string;
    draft: SetupDraft;
    options: SetupOptions;
    // The draft with the agent's ticked changes (#1099); null: the draft.
    refined: SetupProposalResult;
    onRefined: (result: SetupProposalResult) => void;
    onRefining: (busy: boolean) => void;
    onOptions?: (o: SetupOptions) => void;
    // Files the setup adds beside the pipeline, shown whole (the publish workflow of step 2b).
    extraFiles?: PreparedFile[];
    initialRequest?: string;
    pr?: PreparedPrProps;
}) {
    const t = useT();
    const proposed = refined?.proposed ?? draft.proposed;
    const errors = refined?.errors ?? draft.errors;
    const warnings = [...(draft.warnings ?? []), ...(refined?.validatewarnings ?? draft.validatewarnings ?? [])];
    const channels: SetupChannel[] = options.kind === "saas" ? ["public"] : options.channels;
    const diff = useMemo(() => pipelineDiff(draft.current, proposed), [draft.current, proposed]);
    const drawn = useMemo(() => preparedDraft(draft, proposed), [draft, proposed]);
    // The pipeline's technical documentation is one more generated file of the pull request (FR-MC-043).
    const doc = useTechDocPlan(dir, errors.length === 0 && proposed !== draft.current ? proposed : "", "write");
    const docFile = techDocFile(doc.plan);
    const files = preparedFiles(draft, proposed, docFile ? [...(extraFiles ?? []), docFile] : extraFiles);
    const writing = pr?.busy || (pr?.job != null && pr.job.failure == null);
    // A tick re-drafts: it would drop the agent's cards, so the agent's proposal is dropped first.
    const locked = onOptions == null || refined != null || writing;
    const follow = usePrFollow(dir, pr?.job);
    let anyMark = false;
    const models = channels.map((c) => {
        const model = markFlow(flowModel(drawn, c, options.tagprefix), diff);
        anyMark = anyMark || model.nodes.some((n) => n.mark != null);
        return { channel: c, model };
    });
    const who = refined
        ? refined.agentname
            ? t("mc.setup.review.byAgent", { agent: refined.agentname })
            : t("mc.setup.review.byPasted")
        : draft.provider === "saasfoundry"
          ? t("mc.setup.review.bySaaSFoundry")
          : t("mc.setup.review.byMoltenTerm");
    const block = (title: string, desc: string, children: ReactNode, testId?: string) => (
        <div className={BlockClass} data-testid={testId}>
            <span className={ChipClass}>{title}</span>
            <p className="text-11 text-muted">{desc}</p>
            {children}
        </div>
    );
    return (
        <div className="@container flex flex-col gap-3" data-testid="setup-prepared">
            {refined ? null : <FlowReasons draft={draft} options={options} />}
            <div className="flex flex-col gap-2">
                {models.map(({ channel, model }) => (
                    <div key={channel} className="flex flex-col gap-1">
                        {options.kind === "saas" ? null : (
                            <div className="text-11 text-muted">{t(`mc.setup.flow.${channel}`)}</div>
                        )}
                        <FlowDiagram model={model} />
                    </div>
                ))}
                <p className="text-11 text-muted">
                    {t("mc.setup.prepared.diagramLegend", { target: draft.pr?.target || draft.facts.branches.trunk })}
                    {anyMark ? ` ${t("mc.setup.prepared.diagramMarks")}` : ""}
                </p>
            </div>
            <div className="grid grid-cols-1 gap-3 @min-[64rem]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-3">
                    {block(
                        t("mc.setup.prepared.changesTitle"),
                        t("mc.setup.prepared.changesDesc"),
                        <>
                            <p className="text-12 text-secondary">{who}</p>
                            <div className="flex flex-col gap-2" data-testid="prepared-files">
                                {files.map((file) =>
                                    file.kind === "pipeline" ? (
                                        <PipelineFileCard
                                            key={file.path}
                                            file={file}
                                            draft={draft}
                                            options={options}
                                            proposed={proposed}
                                            diff={diff}
                                            locked={locked}
                                            onOptions={onOptions ?? (() => {})}
                                        />
                                    ) : (
                                        <OtherFileCard key={file.path} file={file} />
                                    )
                                )}
                                {files.length === 0 ? (
                                    <p className="text-11 text-muted">{t("mc.setup.prepared.noFiles")}</p>
                                ) : null}
                            </div>
                            {errors.length > 0 ? (
                                <ul
                                    className="flex flex-col gap-0.5 rounded-4 border border-error/40 bg-error/10 px-3 py-1.5 text-11 text-danger"
                                    role="alert"
                                >
                                    {errors.map((e) => (
                                        <li key={e}>{e}</li>
                                    ))}
                                </ul>
                            ) : null}
                            {warnings.length > 0 ? (
                                <ul className="flex flex-col gap-0.5 rounded-4 border border-warning/40 bg-warning/10 px-3 py-1.5 text-11 text-secondary">
                                    {warnings.map((w) => (
                                        <li key={w}>{w}</li>
                                    ))}
                                </ul>
                            ) : null}
                            <div className="flex flex-col gap-1" data-testid="prepared-agent">
                                <span className="text-12 font-medium text-primary">
                                    {t("mc.setup.prepared.agentTitle")}
                                </span>
                                {writing ? (
                                    <p className="text-11 text-muted">{t("mc.setup.prepared.agentClosed")}</p>
                                ) : (
                                    <AgentProposal
                                        key={draft.proposed}
                                        dir={dir}
                                        draftText={draft.proposed}
                                        onResult={onRefined}
                                        onBusy={onRefining}
                                        initialRequest={initialRequest}
                                    />
                                )}
                            </div>
                        </>,
                        "prepared-changes"
                    )}
                    <CommandsBlock current={draft.current} proposed={proposed} />
                    <Sources draft={draft} />
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                    {pr ? (
                        <>
                            <PrPanel
                                dir={dir}
                                plan={draft.pr}
                                choice={pr.ticket}
                                onChoice={pr.onTicket}
                                job={pr.job}
                                busy={pr.busy}
                                error={pr.error}
                                onAgain={pr.onAgain}
                            />
                            <PrFollow
                                dir={dir}
                                job={pr.job}
                                status={follow.status}
                                error={follow.error}
                                onOpenReviews={pr.onOpenReviews}
                            />
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
