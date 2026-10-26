// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The setup's write by pull request (FR-MC-036, #1098): where it starts and goes, the ticket its commit names, the live
// progress of the job, its outcome. The folder opened is never written; "Copy the patch" gives the same commit.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { DominoLoader } from "../suite/suite";
import { DiffView } from "./release-setup";
import { setupPrState, setupTickets } from "./release-setup-client";
import {
    prNamesOf,
    SetupPrIgnored,
    SetupPrJob,
    SetupPrPlan,
    SetupPrStep,
    SetupTicket,
    SetupTicketChoice,
} from "./release-setup-model";

const SectionClass = "flex flex-col gap-2 rounded-6 border border-border p-3";
const SectionTitle = "text-12 font-medium text-primary";
const PollMs = 400;

export const PipelineFile = ".molten/project.json";

// Starts a pull request job and follows it until it ends.
export function useSetupPr() {
    const [job, setJob] = useState<SetupPrJob>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string>(null);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);
    const follow = async (first: SetupPrJob) => {
        let current = first;
        while (alive.current && current != null && !current.finished) {
            await new Promise((resolve) => setTimeout(resolve, PollMs));
            if (!alive.current) {
                return;
            }
            current = await setupPrState(current.id);
            setJob(current);
        }
    };
    const start = (open: () => Promise<SetupPrJob>) =>
        fireAndForget(async () => {
            setStarting(true);
            setError(null);
            setJob(null);
            try {
                const first = await open();
                setJob(first);
                await follow(first);
            } catch (e) {
                if (alive.current) {
                    setError(serverErrorText(e));
                }
            } finally {
                if (alive.current) {
                    setStarting(false);
                }
            }
        });
    const reset = () => {
        setJob(null);
        setError(null);
    };
    const busy = starting || (job != null && !job.finished);
    return { job, busy, error, start, reset };
}

export function UncommittedNotice({
    plan,
    current,
    onInclude,
    asChanges,
}: {
    plan: SetupPrPlan;
    current: string;
    onInclude: (include: boolean) => void;
    // Step 2a of a project already set up lists the included edits as changes of their own (#1102).
    asChanges?: boolean;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    if (plan == null || !plan.uncommitted) {
        return null;
    }
    return (
        <div
            className={cn(
                "flex flex-col gap-1.5 rounded-4 border px-3 py-2 text-12",
                plan.included ? "border-accent/40 bg-accent/10" : "border-warning/40 bg-warning/10"
            )}
            data-testid="setup-uncommitted"
        >
            <p className="text-secondary">
                {plan.included
                    ? t(asChanges ? "mc.setup.pr.includedAsChanges" : "mc.setup.pr.included")
                    : t("mc.setup.pr.uncommitted", { path: PipelineFile, ref: plan.ref || "HEAD" })}
            </p>
            {plan.conflict && !plan.included ? (
                <p className="text-11 text-warning" data-testid="setup-uncommitted-conflict">
                    {t("mc.setup.pr.conflict", { ref: plan.ref || "HEAD" })}
                </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
                {plan.conflict && !plan.included ? null : (
                    <button
                        type="button"
                        className="cursor-pointer text-11 text-primary underline-offset-2 hover:underline"
                        onClick={() => onInclude(!plan.included)}
                        data-testid="setup-include-local"
                    >
                        {plan.included ? t("mc.setup.pr.leaveOut") : t("mc.setup.pr.include")}
                    </button>
                )}
                {plan.local != null ? (
                    <button
                        type="button"
                        className="cursor-pointer text-11 text-muted hover:text-primary"
                        onClick={() => setOpen(!open)}
                    >
                        {open ? t("mc.setup.pr.hideChanges") : t("mc.setup.pr.seeChanges")}
                    </button>
                ) : null}
            </div>
            {open && plan.local != null ? <DiffView before={current} after={plan.local} /> : null}
        </div>
    );
}

function TicketPicker({
    dir,
    plan,
    choice,
    disabled,
    onChange,
}: {
    dir: string;
    plan: SetupPrPlan;
    choice: SetupTicketChoice;
    disabled: boolean;
    onChange: (choice: SetupTicketChoice) => void;
}) {
    const t = useT();
    const [tickets, setTickets] = useState<SetupTicket[]>(null);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        if (!plan.ongithub) {
            return;
        }
        let live = true;
        fireAndForget(async () => {
            try {
                const answer = await setupTickets(dir);
                if (live) {
                    setTickets(answer.tickets ?? []);
                }
            } catch (e) {
                if (live) {
                    setError(serverErrorText(e));
                    setTickets([]);
                }
            }
        });
        return () => {
            live = false;
        };
    }, [dir, plan.ongithub]);
    if (!plan.ongithub) {
        return (
            <input
                type="number"
                min={1}
                className="w-28 rounded-4 border border-border bg-transparent px-2 py-1 text-12"
                value={choice.ticket > 0 ? String(choice.ticket) : ""}
                placeholder={t("mc.setup.pr.ticketNumber")}
                disabled={disabled}
                onChange={(e) => onChange({ ...choice, ticket: Number(e.target.value) || 0, create: false })}
                data-testid="setup-ticket-number"
            />
        );
    }
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <select
                className="max-w-full cursor-pointer rounded-4 border border-border bg-panel px-2 py-1 text-12"
                value={choice.ticket > 0 ? String(choice.ticket) : "new"}
                disabled={disabled || tickets == null}
                onChange={(e) =>
                    onChange(
                        e.target.value === "new"
                            ? { ...choice, ticket: 0, create: true }
                            : { ...choice, ticket: Number(e.target.value), create: false }
                    )
                }
                data-testid="setup-ticket"
            >
                <option value="new">{t("mc.setup.pr.createTicket")}</option>
                {(tickets ?? []).map((ticket) => (
                    <option key={ticket.number} value={String(ticket.number)}>
                        #{ticket.number} · {ticket.title}
                    </option>
                ))}
            </select>
            {tickets == null ? <span className="text-11 text-muted">{t("mc.setup.pr.ticketsLoading")}</span> : null}
            {error ? <span className="text-11 text-warning">{error}</span> : null}
            {choice.ticket > 0 ? null : (
                <input
                    type="text"
                    className="rounded-4 border border-border bg-transparent px-2 py-1 text-12"
                    value={choice.title}
                    placeholder={plan.tickettitle}
                    aria-label={t("mc.setup.pr.ticketTitle")}
                    disabled={disabled}
                    onChange={(e) => onChange({ ...choice, create: true, title: e.target.value })}
                    data-testid="setup-ticket-title"
                />
            )}
        </div>
    );
}

function StepRow({ step, job }: { step: SetupPrStep; job: SetupPrJob }) {
    const t = useT();
    return (
        <li
            className="flex items-center gap-2 text-12"
            data-testid={`setup-pr-step-${step.id}`}
            data-state={step.state}
        >
            <span className="flex w-4 shrink-0 justify-center">
                {step.state === "done" ? <i className="fa fa-solid fa-check text-11 text-success" /> : null}
                {step.state === "running" ? <DominoLoader /> : null}
                {step.state === "failed" ? <i className="fa fa-solid fa-xmark text-11 text-danger" /> : null}
                {step.state === "pending" || step.state === "skipped" ? (
                    <i className="fa fa-regular fa-circle text-11 text-muted" />
                ) : null}
            </span>
            <span
                className={cn(step.state === "pending" || step.state === "skipped" ? "text-muted" : "text-secondary")}
            >
                {t(`mc.setup.pr.step.${step.id}`, { ref: job.ref, branch: job.branch ?? "", target: job.target })}
            </span>
            {step.info ? <code className="font-mono text-11 text-muted">{step.info}</code> : null}
        </li>
    );
}

function Outcome({ job, onAgain }: { job: SetupPrJob; onAgain: () => void }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    if (!job.finished) {
        return null;
    }
    if (job.failure != null) {
        const code = job.failure.code;
        return (
            <div
                className="flex flex-col gap-1.5 rounded-4 border border-error/40 bg-error/10 px-3 py-2 text-12"
                role="alert"
                data-testid="setup-pr-failure"
                data-code={code}
            >
                <p className="text-danger">
                    {t(`mc.setup.pr.failure.${code}`, {
                        ref: job.ref,
                        commit: job.failure.commit ?? "",
                        branch: job.branch ?? "",
                        target: job.target,
                        path: PipelineFile,
                    })}
                </p>
                {job.failure.output ? (
                    <pre className="max-h-24 overflow-auto font-mono text-11 whitespace-pre-wrap text-secondary">
                        {job.failure.output}
                    </pre>
                ) : null}
                {code === "moved" || code === "localChanged" || code === "updateChanged" ? (
                    <div>
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-6 px-3 py-1 text-11"
                            onClick={onAgain}
                            data-testid="setup-pr-again"
                        >
                            {t("mc.setup.pr.prepareAgain")}
                        </button>
                    </div>
                ) : null}
            </div>
        );
    }
    if (job.mode === "patch") {
        return (
            <div className="flex flex-wrap items-center gap-2 text-12 text-secondary" data-testid="setup-pr-patch">
                <span>{copied ? t("mc.setup.pr.copied") : t("mc.setup.pr.patchReady")}</span>
                <button
                    type="button"
                    className="cursor-pointer rounded-4 border border-border px-2 py-1 text-11 text-secondary hover:bg-hover hover:text-primary"
                    onClick={() =>
                        fireAndForget(async () => {
                            await navigator.clipboard.writeText(job.patch ?? "");
                            setCopied(true);
                        })
                    }
                >
                    {t("mc.setup.pr.copyAgain")}
                </button>
            </div>
        );
    }
    if (job.prurl) {
        return (
            <div className="flex flex-wrap items-center gap-2 text-12 text-secondary" data-testid="setup-pr-done">
                <span>{t("mc.setup.pr.done", { number: String(job.prnumber ?? ""), target: job.target })}</span>
                <a
                    href={job.prurl}
                    onClick={(e) => {
                        e.preventDefault();
                        fireAndForget(() => openWebLink(job.prurl));
                    }}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-6 border border-border px-2 py-1 text-11 text-secondary hover:bg-hover hover:text-primary"
                >
                    {t("mc.setup.pr.openPr", { number: String(job.prnumber ?? "") })}
                    <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                </a>
                {job.docurl ? (
                    <a
                        href={job.docurl}
                        onClick={(e) => {
                            e.preventDefault();
                            fireAndForget(() => openWebLink(job.docurl));
                        }}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-6 border border-border px-2 py-1 text-11 text-secondary hover:bg-hover hover:text-primary"
                        data-testid="setup-pr-doc"
                    >
                        {t("mc.setup.techdoc.openPage")}
                        <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                    </a>
                ) : null}
            </div>
        );
    }
    return (
        <p className="text-12 text-secondary" data-testid="setup-pr-pushed">
            {t("mc.setup.pr.pushedOnly", { branch: job.branch ?? "", target: job.target })}
        </p>
    );
}

// An ignore rule matched files the setup wrote: they are committed anyway, and the rule's place is named (#1146).
function IgnoredNote({ ignored }: { ignored: SetupPrIgnored[] }) {
    const t = useT();
    if (!ignored?.length) {
        return null;
    }
    return (
        <div className="flex flex-col gap-1 rounded-4 border border-border px-3 py-2 text-12" data-testid="setup-pr-ignored">
            {ignored.map((rule) => (
                <p key={rule.source + "\u0000" + rule.pattern} className="text-secondary">
                    {t(rule.shared ? "mc.setup.pr.ignored.shared" : "mc.setup.pr.ignored.local", {
                        pattern: rule.pattern,
                        source: rule.source,
                        files: rule.files.join(", "),
                    })}
                </p>
            ))}
        </div>
    );
}

// The Validate block: the plan before the click, the job's progress and outcome after it.
export function PrPanel({
    dir,
    plan,
    choice,
    onChoice,
    job,
    busy,
    error,
    onAgain,
}: {
    dir: string;
    plan: SetupPrPlan;
    choice: SetupTicketChoice;
    onChoice: (choice: SetupTicketChoice) => void;
    job: SetupPrJob;
    busy: boolean;
    error: string;
    onAgain: () => void;
}) {
    const t = useT();
    const panel = useRef<HTMLDivElement>(null);
    // The block sits under the diff: the progress and the outcome are brought into view.
    useEffect(() => {
        if (job?.id) {
            panel.current?.scrollIntoView?.({ block: "nearest" });
        }
    }, [job?.id, job?.finished]);
    if (plan == null) {
        return null;
    }
    if (!plan.git) {
        return (
            <div className={SectionClass} data-testid="setup-pr">
                <div className={SectionTitle}>{t("mc.setup.pr.title")}</div>
                <p className="text-12 text-warning">{t("mc.setup.pr.noGit")}</p>
            </div>
        );
    }
    const live = job != null && job.failure == null ? job : null;
    // A failed job's created ticket is the one a retry reuses (#1146).
    const names = prNamesOf(plan, live?.ticket || choice.ticket || (choice.create ? job?.ticket : 0));
    // After a failure the ticket can change (a branch that already exists takes another ticket).
    const locked = busy || (job?.finished && job.failure == null);
    return (
        <div className={SectionClass} data-testid="setup-pr" ref={panel}>
            <div className={SectionTitle}>{t("mc.setup.pr.title")}</div>
            <p className="text-11 text-muted">
                {plan.ongithub
                    ? t("mc.setup.pr.desc")
                    : plan.remote === false
                      ? t("mc.setup.pr.descNoRemote")
                      : t("mc.setup.pr.descPatch")}
            </p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-12">
                {plan.ticketrequired ? (
                    <>
                        <dt className="text-muted">{t("mc.setup.pr.ticket")}</dt>
                        <dd className="min-w-0">
                            <TicketPicker dir={dir} plan={plan} choice={choice} disabled={locked} onChange={onChoice} />
                        </dd>
                    </>
                ) : null}
                <dt className="text-muted">{t("mc.setup.pr.branch")}</dt>
                <dd className="min-w-0 font-mono text-11 wrap-anywhere text-secondary" data-testid="setup-pr-branch">
                    {live?.branch || names.branch}
                </dd>
                <dt className="text-muted">{t("mc.setup.pr.commit")}</dt>
                <dd className="min-w-0 font-mono text-11 wrap-anywhere text-secondary" data-testid="setup-pr-subject">
                    {live?.subject || names.subject}
                </dd>
                <dt className="text-muted">{t("mc.setup.pr.into")}</dt>
                <dd className="font-mono text-11 text-secondary">
                    {plan.target}
                    <span className="ml-2 font-sans text-muted">
                        {t("mc.setup.pr.from", { ref: plan.ref, commit: plan.commit })}
                    </span>
                </dd>
            </dl>
            {job != null ? (
                <ol className="flex flex-col gap-1" data-testid="setup-pr-steps">
                    {job.steps.map((s) => (
                        <StepRow key={s.id} step={s} job={job} />
                    ))}
                </ol>
            ) : (
                <p className="text-11 text-muted">{t("mc.setup.pr.after", { target: plan.target })}</p>
            )}
            {job != null ? <IgnoredNote ignored={job.ignored} /> : null}
            {job != null ? <Outcome job={job} onAgain={onAgain} /> : null}
            {error ? (
                <p className="text-12 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

// The footer's actions: "Open the pull request" on GitHub with "Copy the patch" beside it; outside GitHub the patch is
// the action. Nothing once the pull request is open.
export function PrFooterButtons({
    plan,
    job,
    busy,
    canOpen,
    canPatch,
    onOpen,
}: {
    plan: SetupPrPlan;
    job: SetupPrJob;
    busy: boolean;
    canOpen: boolean;
    canPatch: boolean;
    onOpen: (mode: "pr" | "patch") => void;
}) {
    const t = useT();
    if (job?.finished && job.failure == null && job.mode === "pr") {
        return null;
    }
    const primary =
        "molten-btn inline-flex cursor-pointer items-center rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50";
    const plain =
        "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
    const github = plan?.ongithub;
    return (
        <>
            <button
                key="patch"
                type="button"
                className={github ? plain : primary}
                disabled={!canPatch || busy}
                onClick={() => onOpen("patch")}
                data-testid="setup-copy-patch"
            >
                {busy && job?.mode === "patch" ? <DominoLoader className="mr-1.5" /> : null}
                {t("mc.setup.pr.copyPatch")}
                {github ? null : <MoltenWave />}
            </button>
            {github ? (
                <button
                    key="write"
                    type="button"
                    className={primary}
                    disabled={!canOpen || busy}
                    onClick={() => onOpen("pr")}
                    data-testid="setup-write"
                >
                    {busy && job?.mode !== "patch" ? <DominoLoader className="mr-1.5" /> : null}
                    {t("mc.setup.pr.open")}
                    <MoltenWave />
                </button>
            ) : null}
        </>
    );
}

// The patch of a finished patch job goes to the clipboard as soon as it is there.
export function useCopyPatch(job: SetupPrJob) {
    const copied = useRef<string>(null);
    useEffect(() => {
        if (job == null || job.mode !== "patch" || !job.finished || job.failure != null || !job.patch) {
            return;
        }
        if (copied.current === job.id) {
            return;
        }
        copied.current = job.id;
        fireAndForget(() => navigator.clipboard.writeText(job.patch));
    }, [job]);
}
