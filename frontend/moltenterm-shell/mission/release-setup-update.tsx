// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Update the release setup" (FR-MC-036, #1086): what this version of MoltenTerm writes differently from the pipeline a
// former setup wrote, change by change with the reason, then the file's diff. A step the developer edited or added is
// kept unless they tick the new version. The click opens a draft pull request from a worktree of MoltenTerm's; the
// folder opened is never written (#1098).

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { DominoLoader } from "../suite/suite";
import { DiffView, NewTicketChoice } from "./release-setup";
import { setupCheck, setupUpdate } from "./release-setup-client";
import {
    canOpenPr,
    changeGroups,
    changeTaken,
    prRequestOf,
    SetupChange,
    SetupCheck,
    SetupTicketChoice,
    SetupUpdateReason,
} from "./release-setup-model";
import { PrFooterButtons, PrPanel, UncommittedNotice, useCopyPatch, useSetupPr } from "./release-setup-pr";

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const SectionClass = "flex flex-col gap-2 rounded-6 border border-border p-3";
const SectionTitle = "text-12 font-medium text-primary";

export function useReasonText() {
    const t = useT();
    return (reason: SetupUpdateReason) =>
        t(`mc.setup.update.reason.${reason.code}`, { branch: reason.detail ?? "", count: reason.detail ?? "" });
}

function ChangeRow({
    change,
    taken,
    onTake,
}: {
    change: SetupChange;
    taken: boolean;
    onTake: (take: boolean) => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(change.customised);
    return (
        <li
            className="flex flex-col gap-1.5 rounded-4 border border-border px-2.5 py-2"
            data-testid={`update-change-${change.key}`}
        >
            <div className="flex flex-wrap items-center gap-2">
                <span
                    className={cn(
                        "rounded-full border px-1.5 text-11 leading-4",
                        change.kind === "added" && "border-success/50 text-success",
                        change.kind === "removed" && "border-error/50 text-danger",
                        (change.kind === "changed" || change.kind === "versions") && "border-accent/50 text-accent"
                    )}
                >
                    {t(`mc.setup.update.kind.${change.kind}`)}
                </span>
                <span className="min-w-0 flex-1 text-12 text-primary">
                    {change.kind === "versions" ? t("mc.setup.update.versionsTitle") : change.title || change.id}
                </span>
                <button
                    type="button"
                    className="cursor-pointer text-11 text-muted hover:text-primary"
                    onClick={() => setOpen(!open)}
                >
                    {open ? t("mc.setup.update.hide") : t("mc.setup.update.show")}
                </button>
            </div>
            {change.customised ? (
                <p className="text-11 text-warning">{t(`mc.setup.update.customised.${change.kind}`)}</p>
            ) : null}
            <label className="flex cursor-pointer items-center gap-2 text-11 text-secondary">
                <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={taken}
                    onChange={(e) => onTake(e.target.checked)}
                    data-testid={`update-take-${change.key}`}
                />
                {change.customised ? t(`mc.setup.update.useNew.${change.kind}`) : t("mc.setup.update.apply")}
            </label>
            {open ? (
                <div className="grid gap-2 @min-[40rem]:grid-cols-2">
                    {change.before ? (
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-11 text-muted uppercase">{t("mc.setup.update.before")}</span>
                            <pre className="overflow-auto rounded-4 bg-black/30 p-2 font-mono text-11 whitespace-pre-wrap text-secondary">
                                {change.before}
                            </pre>
                        </div>
                    ) : null}
                    {change.after ? (
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-11 text-muted uppercase">{t("mc.setup.update.after")}</span>
                            <pre className="overflow-auto rounded-4 bg-black/30 p-2 font-mono text-11 whitespace-pre-wrap text-secondary">
                                {change.after}
                            </pre>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </li>
    );
}

export function UpdateBody({
    check,
    choices,
    onChoose,
}: {
    check: SetupCheck;
    choices: Record<string, boolean>;
    onChoose: (key: string, take: boolean) => void;
}) {
    const t = useT();
    const reasonText = useReasonText();
    return (
        <div className="@container flex flex-col gap-3">
            <div className={SectionClass} data-testid="update-reasons">
                <div className={SectionTitle}>{t("mc.setup.update.why")}</div>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-12 text-secondary">
                    {check.reasons.map((r) => (
                        <li key={r.code}>{reasonText(r)}</li>
                    ))}
                </ul>
                {check.recordtemplate === 0 ? (
                    <p className="text-11 text-muted">{t("mc.setup.update.noRecord")}</p>
                ) : null}
            </div>
            {changeGroups(check.changes).map(({ group, changes }) => (
                <div key={group} className={SectionClass}>
                    <div className={SectionTitle}>{t(`mc.setup.update.group.${group}`)}</div>
                    <ul className="flex flex-col gap-1.5">
                        {changes.map((c) => (
                            <ChangeRow
                                key={c.key}
                                change={c}
                                taken={changeTaken(c, choices)}
                                onTake={(take) => onChoose(c.key, take)}
                            />
                        ))}
                    </ul>
                </div>
            ))}
            <div className={SectionClass}>
                <div className={SectionTitle}>{t("mc.setup.update.files")}</div>
                <p className="text-11 text-muted">
                    {check.proposed === check.current ? t("mc.setup.update.keepAll") : t("mc.setup.update.filesHint")}
                </p>
                <DiffView before={check.current} after={check.proposed} />
            </div>
            {check.errors.length > 0 ? (
                <p
                    className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-danger"
                    role="alert"
                >
                    {t("mc.setup.update.invalid", { errors: check.errors.join("; ") })}
                </p>
            ) : null}
        </div>
    );
}

export function ReleaseSetupUpdate({
    dir,
    projectName,
    onClose,
    onWritten,
}: {
    dir: string;
    projectName: string;
    onClose: () => void;
    onWritten: () => void;
}) {
    const t = useT();
    const [check, setCheck] = useState<SetupCheck>(null);
    const [choices, setChoices] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>(null);
    const [includeLocal, setIncludeLocal] = useState(false);
    const [ticket, setTicket] = useState<SetupTicketChoice>(NewTicketChoice);
    const pr = useSetupPr();
    useCopyPatch(pr.job);
    const writing = pr.busy;
    const request = useRef(0);

    const load = (next: Record<string, boolean>, include = includeLocal) =>
        fireAndForget(async () => {
            const n = ++request.current;
            setLoading(true);
            try {
                const answer = await setupCheck(dir, next, include);
                if (n !== request.current) {
                    return;
                }
                setCheck(answer);
                setError(null);
            } catch (e) {
                if (n === request.current) {
                    setError(serverErrorText(e));
                }
            } finally {
                if (n === request.current) {
                    setLoading(false);
                }
            }
        });

    useEffect(() => {
        load({});
    }, [dir]);

    const choose = (key: string, take: boolean) => {
        const next = { ...choices, [key]: take };
        setChoices(next);
        load(next);
    };
    const update = (mode: "pr" | "patch") =>
        pr.start(async () => {
            const job = await setupUpdate(
                dir,
                check.base,
                check.signature,
                choices,
                prRequestOf(check.pr, ticket, mode)
            );
            onWritten();
            return job;
        });
    const include = (on: boolean) => {
        setIncludeLocal(on);
        load(choices, on);
    };
    const again = () => {
        pr.reset();
        load(choices);
    };

    const done = pr.job?.finished && pr.job.failure == null;
    // Keeping every change still writes: the choices are recorded so they are not offered again.
    const ready = check != null && check.state === "update" && !loading && check.errors.length === 0 && !done;
    const canUpdate = ready && canOpenPr(check.pr, ticket, "pr");
    const canPatch = ready && canOpenPr(check.pr, ticket, "patch");
    return (
        <DialogFrame
            role="mc-release-setup-update"
            title={t("mc.setup.update.title", { project: projectName })}
            subtitle={t("mc.setup.update.subtitle")}
            subtitleWraps
            fill
            onEscape={writing ? undefined : onClose}
            buttons={
                <>
                    {loading ? <DominoLoader className="mr-auto" /> : null}
                    <button type="button" className={PlainButton} onClick={onClose} disabled={writing}>
                        {done ? t("common.close") : t("common.cancel")}
                    </button>
                    {check?.state === "update" ? (
                        <PrFooterButtons
                            plan={check.pr}
                            job={pr.job}
                            busy={writing}
                            canOpen={canUpdate}
                            canPatch={canPatch}
                            onOpen={update}
                        />
                    ) : null}
                </>
            }
        >
            {error ? (
                <p
                    className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-danger"
                    role="alert"
                >
                    {error}
                </p>
            ) : null}
            {check == null ? (
                error ? null : (
                    <div className="flex items-center gap-2 py-6 text-12 text-muted">
                        <DominoLoader />
                        {t("mc.setup.reading")}
                    </div>
                )
            ) : check.state === "update" ? (
                <>
                    {writing || done ? null : (
                        <UncommittedNotice plan={check.pr} current={check.current} onInclude={include} />
                    )}
                    <UpdateBody check={check} choices={choices} onChoose={writing || done ? () => {} : choose} />
                    <PrPanel
                        dir={dir}
                        plan={check.pr}
                        choice={ticket}
                        onChoice={setTicket}
                        job={pr.job}
                        busy={writing}
                        error={pr.error}
                        onAgain={again}
                    />
                </>
            ) : (
                <p className="py-4 text-12 text-secondary">{t("mc.setup.update.upToDate")}</p>
            )}
        </DialogFrame>
    );
}
