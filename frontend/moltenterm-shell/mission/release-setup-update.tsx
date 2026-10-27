// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2a of the pipeline setup for a project already set up (FR-MC-040, #1102), the #1086 update inside the stepper
// (FR-MC-036): the declared pipeline drawn with a numbered badge on each change this version of MoltenTerm proposes,
// the changes listed with the same numbers (the developer's uncommitted edits first when included), each taken or
// kept, and "All the choices" to adjust even an up-to-date pipeline. Step 3 shows the file and opens the draft pull
// request through Update; the folder opened is never written (#1098).

import { cn, fireAndForget } from "@/util/util";
import { ReactNode, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { setupCheck } from "./release-setup-client";
import { FlowDiagram } from "./release-setup-diagram";
import {
    changeGroups,
    changeTaken,
    FlowModel,
    flowModel,
    SetupChange,
    SetupChannel,
    SetupCheck,
    SetupDraft,
    SetupOptions,
    setupReasonText,
} from "./release-setup-model";

const SectionClass = "flex flex-col gap-2 rounded-6 border border-border p-3";
const SectionTitle = "text-12 font-medium text-primary";
const ChipClass = "self-start rounded-4 border border-border px-1.5 py-0.5 text-10 tracking-wide text-muted uppercase";

// The badge colours of the diagram (release-setup-diagram.tsx ChangeColors), as Tailwind classes.
const KindClass: Record<SetupChange["kind"], string> = {
    added: "bg-success text-background",
    removed: "bg-error text-background",
    changed: "bg-warning text-background",
    versions: "bg-warning text-background",
};

// changeNumbers numbers the changes in the order the list shows them, as the diagram's badges do.
export function changeNumbers(changes: readonly SetupChange[]): Record<string, number> {
    const numbers: Record<string, number> = {};
    let n = 0;
    for (const { changes: list } of changeGroups(changes)) {
        for (const c of list) {
            numbers[c.key] = ++n;
        }
    }
    return numbers;
}

// The step a change is about, as the diagram keys its nodes ("public/open-pr"); "" for the version files and the
// edits outside the release steps.
function nodeKeyOf(change: SetupChange): string {
    if (!change.channel || !change.id) {
        return "";
    }
    return `${change.channel}/${change.id}`;
}

// updateFlowModel draws one channel of the declared pipeline (the check's drawn block: the declared steps, the ones
// the update adds in place, the removed ones kept), each changed step with its number and kind, dimmed when not taken.
export function updateFlowModel(
    draft: SetupDraft,
    check: SetupCheck,
    channel: SetupChannel,
    choices: Record<string, boolean>
): FlowModel {
    const options = { ...draft.options, ...(check.options ?? {}), kind: "on-premise" as const };
    const model = flowModel(
        { ...draft, options, proposal: { release: check.drawn ?? {}, sources: {} } },
        channel,
        options.tagprefix || draft.facts.tagprefix
    );
    const numbers = changeNumbers(check.changes);
    const byNode = new Map<string, SetupChange>();
    for (const c of check.changes ?? []) {
        const key = nodeKeyOf(c);
        const seen = byNode.get(key);
        if (key && (seen == null || numbers[c.key] < numbers[seen.key])) {
            byNode.set(key, c);
        }
    }
    for (const node of model.nodes) {
        const c = byNode.get(node.key);
        if (c == null) {
            continue;
        }
        node.badge = numbers[c.key];
        node.change = c.kind;
        node.untaken = !changeTaken(c, choices);
    }
    return model;
}

// useSetupCheck holds the update check of step 2a (#1102): the ticks, the choices adjusted and whether the
// uncommitted edits are included; each change checks again, the latest answer wins.
export function useSetupCheck(dir: string) {
    const [check, setCheck] = useState<SetupCheck>(null);
    const [choices, setChoices] = useState<Record<string, boolean>>({});
    const [options, setOptions] = useState<SetupOptions>(null);
    const [includeLocal, setIncludeLocal] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>(null);
    const request = useRef(0);
    const load = (next: Record<string, boolean>, include: boolean, opts: SetupOptions) =>
        fireAndForget(async () => {
            const n = ++request.current;
            setLoading(true);
            try {
                const answer = await setupCheck(dir, next, include, opts, true);
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
    return {
        check,
        choices,
        options,
        includeLocal,
        loading,
        error,
        start: (saved?: { options?: SetupOptions; choices?: Record<string, boolean> }) => {
            setChoices(saved?.choices ?? {});
            setOptions(saved?.options ?? null);
            load(saved?.choices ?? {}, includeLocal, saved?.options ?? null);
        },
        choose: (key: string, take: boolean) => {
            const next = { ...choices, [key]: take };
            setChoices(next);
            load(next, includeLocal, options);
        },
        adjust: (next: SetupOptions) => {
            setOptions(next);
            load(choices, includeLocal, next);
        },
        include: (on: boolean) => {
            setIncludeLocal(on);
            load(choices, on, options);
        },
        reload: () => load(choices, includeLocal, options),
    };
}

export type SetupCheckState = ReturnType<typeof useSetupCheck>;

// The update can open a pull request: something changes, or a choice is recorded.
export function updateReady(check: SetupCheck): boolean {
    return check != null && check.state === "update" && check.errors.length === 0;
}

function ChangeRow({
    change,
    number,
    taken,
    disabled,
    onTake,
}: {
    change: SetupChange;
    number: number;
    taken: boolean;
    disabled: boolean;
    onTake: (take: boolean) => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(change.customised);
    const title =
        change.key === "local/file"
            ? t("mc.setup.update.localFile", { keys: change.title ?? "" })
            : change.kind === "versions"
              ? t("mc.setup.update.versionsTitle")
              : change.title || change.id;
    return (
        <li
            className={cn(
                "flex flex-col gap-1.5 rounded-4 border px-2.5 py-2",
                taken ? "border-border" : "border-border/60 opacity-80"
            )}
            data-testid={`update-change-${change.key}`}
        >
            <div className="flex flex-wrap items-center gap-2">
                <span
                    className={cn(
                        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-11 font-semibold",
                        KindClass[change.kind],
                        !taken && "opacity-50"
                    )}
                >
                    {number}
                </span>
                <span
                    className={cn(
                        "rounded-full border px-1.5 text-11 leading-4",
                        change.kind === "added" && "border-success/50 text-success",
                        change.kind === "removed" && "border-error/50 text-danger",
                        (change.kind === "changed" || change.kind === "versions") && "border-warning/50 text-warning"
                    )}
                >
                    {t(`mc.setup.update.kind.${change.kind}`)}
                </span>
                <span className="min-w-0 flex-1 text-12 text-primary wrap-anywhere">{title}</span>
                {change.customised ? (
                    <span className="rounded-full border border-border px-1.5 text-10 leading-4 text-muted">
                        {taken ? t("mc.setup.update.yoursReplaced") : t("mc.setup.update.yoursKept")}
                    </span>
                ) : null}
                <button
                    type="button"
                    className="cursor-pointer text-11 text-muted hover:text-primary"
                    onClick={() => setOpen(!open)}
                >
                    {open ? t("mc.setup.update.hide") : t("mc.setup.update.show")}
                </button>
            </div>
            {change.local ? (
                <p className="text-11 text-muted">{t(`mc.setup.update.local.${change.kind}`)}</p>
            ) : change.customised ? (
                <p className="text-11 text-warning">{t(`mc.setup.update.customised.${change.kind}`)}</p>
            ) : null}
            <label
                className={cn(
                    "flex items-center gap-2 text-11 text-secondary",
                    disabled ? "opacity-60" : "cursor-pointer"
                )}
            >
                <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={taken}
                    disabled={disabled}
                    onChange={(e) => onTake(e.target.checked)}
                    data-testid={`update-take-${change.key}`}
                />
                {change.local
                    ? t("mc.setup.update.takeLocal")
                    : change.customised
                      ? t(`mc.setup.update.useNew.${change.kind}`)
                      : t("mc.setup.update.apply")}
            </label>
            {open ? (
                <div className="grid gap-2 @min-[40rem]:grid-cols-2">
                    {change.before ? (
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-11 text-muted uppercase">
                                {change.local ? t("mc.setup.update.committed") : t("mc.setup.update.before")}
                            </span>
                            <pre className="overflow-auto rounded-4 bg-black/30 p-2 font-mono text-11 whitespace-pre-wrap text-secondary">
                                {change.before}
                            </pre>
                        </div>
                    ) : null}
                    {change.after ? (
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-11 text-muted uppercase">
                                {change.local ? t("mc.setup.update.yourEdit") : t("mc.setup.update.after")}
                            </span>
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

// The changes by group, numbered as the diagram's badges.
export function UpdateChanges({
    check,
    choices,
    disabled,
    onChoose,
}: {
    check: SetupCheck;
    choices: Record<string, boolean>;
    disabled?: boolean;
    onChoose: (key: string, take: boolean) => void;
}) {
    const t = useT();
    const numbers = changeNumbers(check.changes);
    const groups = changeGroups(check.changes);
    if (groups.length === 0) {
        return null;
    }
    return (
        <div className={SectionClass} data-testid="update-changes">
            <div className="flex flex-wrap items-baseline gap-2">
                <span className={SectionTitle}>{t("mc.setup.update.changes")}</span>
                <span className="text-11 text-muted">{t("mc.setup.update.changesHint")}</span>
            </div>
            {groups.map(({ group, changes }) => (
                <div key={group} className="flex flex-col gap-1.5" data-testid={`update-group-${group}`}>
                    <div className="text-11 text-muted">{t(`mc.setup.update.group.${group}`)}</div>
                    <ul className="flex flex-col gap-1.5">
                        {changes.map((c) => (
                            <ChangeRow
                                key={c.key}
                                change={c}
                                number={numbers[c.key]}
                                taken={changeTaken(c, choices)}
                                disabled={disabled}
                                onTake={(take) => onChoose(c.key, take)}
                            />
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}

function UpdateHeadline({ check }: { check: SetupCheck }) {
    const t = useT();
    const setUpBy =
        check.recordtemplate > 0
            ? t("mc.setup.update.setUpBy", { record: check.recordtemplate, template: check.template })
            : t("mc.setup.update.noRecord");
    if (check.state !== "update") {
        return (
            <div
                className="flex flex-col gap-1 rounded-6 border border-success/40 bg-success/10 px-3 py-2"
                data-testid="update-uptodate"
            >
                <div className="flex items-center gap-2 text-12 font-medium text-primary">
                    <i className="fa fa-solid fa-check text-11 text-success" />
                    {t("mc.setup.update.upToDateTitle")}
                </div>
                <p className="text-12 text-secondary">
                    {t("mc.setup.update.upToDateHint", { template: check.template })}
                </p>
                <p className="text-11 text-muted">{setUpBy}</p>
            </div>
        );
    }
    return (
        <div
            className="flex flex-col gap-1 rounded-6 border border-accent/40 bg-accent/10 px-3 py-2"
            data-testid="update-reasons"
        >
            <div className="text-12 font-medium text-primary">{t("mc.setup.update.why")}</div>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-12 text-secondary">
                {check.reasons.map((r) => (
                    <li key={r.code}>{setupReasonText(t, r)}</li>
                ))}
            </ul>
            <p className="text-11 text-muted">{setUpBy}</p>
        </div>
    );
}

// Step 2a for a project already set up: the headline, the declared pipeline drawn with the changes, the change list,
// and the choices to adjust (children: the Choices step, which lives with the stepper).
export function UpdateStep({
    draft,
    check,
    choices,
    disabled,
    onChoose,
    children,
}: {
    draft: SetupDraft;
    check: SetupCheck;
    choices: Record<string, boolean>;
    disabled?: boolean;
    onChoose: (key: string, take: boolean) => void;
    children?: ReactNode;
}) {
    const t = useT();
    const [channel, setChannel] = useState<SetupChannel>("public");
    return (
        <div className="flex flex-col gap-3" data-testid="setup-update">
            <UpdateHeadline check={check} />
            <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={ChipClass}>{t("mc.setup.update.declared")}</span>
                    <div className="flex gap-1" role="tablist">
                        {(["public", "rc"] as SetupChannel[]).map((c) => (
                            <button
                                key={c}
                                type="button"
                                role="tab"
                                aria-selected={channel === c}
                                onClick={() => setChannel(c)}
                                className={cn(
                                    "cursor-pointer rounded-4 border px-3 py-1 text-11",
                                    channel === c ? "border-accent/60 text-primary" : "border-border text-secondary"
                                )}
                                data-testid={`update-channel-${c}`}
                            >
                                {t(`mc.setup.flow.${c}`)}
                            </button>
                        ))}
                    </div>
                </div>
                <FlowDiagram model={updateFlowModel(draft, check, channel, choices)} />
            </div>
            <UpdateChanges check={check} choices={choices} disabled={disabled} onChoose={onChoose} />
            {check.errors.length > 0 ? (
                <p
                    className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-danger"
                    role="alert"
                >
                    {t("mc.setup.update.invalid", { errors: check.errors.join("; ") })}
                </p>
            ) : null}
            {children ? (
                <details className="rounded-6 border border-border px-3 py-2" data-testid="update-all-choices">
                    <summary className="cursor-pointer text-12 text-primary">
                        {t("mc.setup.analyse.allChoices")}
                    </summary>
                    <p className="mt-1 text-11 text-muted">
                        {check.adjusted ? t("mc.setup.update.adjusted") : t("mc.setup.update.adjustHint")}
                    </p>
                    <div className="mt-2 flex flex-col gap-3">{children}</div>
                </details>
            ) : null}
        </div>
    );
}

// Step 3 of the update, above the prepared pipeline (#1106): what the pull request writes, in one line.
export function UpdateFilesNote({ check }: { check: SetupCheck }) {
    const t = useT();
    // Which blocks of which files change is a technical detail (#1163): it waits behind the details, closed.
    return (
        <details className="text-11 text-muted" data-testid="update-files">
            <summary className="cursor-pointer">{t("mc.setup.plain.technical.show")}</summary>
            <p className="mt-1">
                {check.state !== "update"
                    ? t("mc.setup.update.nothing")
                    : check.proposed === check.current
                      ? t("mc.setup.update.keepAll")
                      : t("mc.setup.update.filesHint")}
            </p>
        </details>
    );
}
