// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "What MoltenTerm learned" (FR-LRN-003, DS-LRN-004): what a workflow learned of the developer, in plain words, each
// item with how often it was seen, when and by whom, to edit or forget, and the whole workflow to reset. One body for
// Settings and for the workflow views; a view embeds LearnedSection, folded to one line with the count. Nothing here
// changes by itself: every change is the developer's click.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { TFunction, useLocale, useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { learningEdit, learningForget, learningReset } from "./learning-client";
import {
    ByAgent,
    ByUser,
    confidenceKey,
    FlagOff,
    FlagOn,
    holdsValue,
    itemSentence,
    itemTitle,
    keyInfo,
    LearningItem,
    valueText,
    workflowInfo,
} from "./learning-model";
import { useLearned } from "./use-learned";

const SecondaryButton =
    "molten-btn-secondary inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 py-0.5 text-12";
const GhostButton =
    "molten-btn-ghost inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 py-0.5 text-12";
const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12";
const InputClass =
    "h-7 max-w-full min-w-0 rounded-4 border border-line-strong bg-transparent px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";

export function workflowName(workflow: string, t: TFunction): string {
    const info = workflowInfo(workflow);
    return info != null ? t(info.nameKey) : workflow;
}

// "Seen 3 times, settled · recorded by an agent · run my-project · 4 Nov 2026".
export function itemMeta(
    item: LearningItem,
    t: TFunction,
    tCount: (k: string, n: number) => string,
    locale: string
): string {
    const parts = [`${tCount("learning.meta.seen", item.seen)}, ${t(confidenceKey(item.confidence))}`];
    const by = item.source?.by;
    if (by === ByAgent || by === ByUser) {
        parts.push(t(`learning.by.${by}`));
    }
    if (item.source?.run) {
        parts.push(t("learning.meta.run", { run: item.source.run }));
    }
    if (item.source?.at > 0) {
        parts.push(
            new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(item.source.at)
        );
    }
    return parts.join(" · ");
}

type Choice = { value: string; label: string };

// The values the edit field offers: the options of a choice, yes or no for a switch, nothing for free text.
export function editChoices(workflow: string, item: LearningItem, t: TFunction): Choice[] {
    const info = keyInfo(workflow, item.key);
    if (info?.control === "flag") {
        return [FlagOn, FlagOff].map((value) => ({ value, label: valueText(workflow, item.key, value, t) }));
    }
    if (info?.control === "choice") {
        return (info.choices ?? []).map((value) => ({ value, label: valueText(workflow, item.key, value, t) }));
    }
    return [];
}

function ItemRow({
    workflow,
    item,
    onChanged,
    onError,
}: {
    workflow: string;
    item: LearningItem;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const locale = useLocale();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(item.value ?? "");
    const choices = editChoices(workflow, item, t);
    const editable = holdsValue(item.kind);
    const sentence = itemSentence(workflow, item, t);
    const fail = (e: unknown) => onError(serverErrorText(e));
    const save = () =>
        fireAndForget(async () => {
            try {
                await learningEdit(workflow, item.id, draft.trim());
                setEditing(false);
                onChanged();
            } catch (e) {
                fail(e);
            }
        });
    const forget = () =>
        fireAndForget(async () => {
            try {
                await learningForget(workflow, item.id);
                onChanged();
            } catch (e) {
                fail(e);
            }
        });
    return (
        <li className="flex items-center gap-4 px-5 py-3" data-testid="learning-item" data-item-id={item.id}>
            <div className="min-w-0 flex-1">
                {editing ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-12 text-secondary">{itemTitle(workflow, item, t)}</span>
                        {choices.length > 0 ? (
                            <select
                                aria-label={sentence}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                className={cn(InputClass, "cursor-pointer bg-surface-2 pr-1")}
                                data-testid="learning-edit-field"
                            >
                                {choices.some((c) => c.value === draft) ? null : <option value={draft}>{draft}</option>}
                                {choices.map((c) => (
                                    <option key={c.value} value={c.value}>
                                        {c.label}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <input
                                aria-label={sentence}
                                value={draft}
                                maxLength={200}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") save();
                                    if (e.key === "Escape") setEditing(false);
                                }}
                                className={cn(InputClass, "w-48")}
                                data-testid="learning-edit-field"
                            />
                        )}
                    </div>
                ) : (
                    <div className="text-12 break-words text-primary" data-testid="learning-sentence">
                        {sentence}
                    </div>
                )}
                <div className="text-11 text-muted">{itemMeta(item, t, tCount, locale)}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                {editing ? (
                    <>
                        <button
                            type="button"
                            className={SecondaryButton}
                            onClick={save}
                            disabled={draft.trim() === ""}
                            data-testid="learning-save"
                        >
                            {t("learning.save")}
                        </button>
                        <button type="button" className={GhostButton} onClick={() => setEditing(false)}>
                            {t("learning.cancel")}
                        </button>
                    </>
                ) : (
                    <>
                        {editable ? (
                            <button
                                type="button"
                                className={GhostButton}
                                onClick={() => {
                                    setDraft(item.value ?? "");
                                    setEditing(true);
                                }}
                                data-testid="learning-edit"
                            >
                                {t("learning.edit")}
                            </button>
                        ) : null}
                        <button type="button" className={GhostButton} onClick={forget} data-testid="learning-forget">
                            {t("learning.forget")}
                        </button>
                    </>
                )}
            </div>
        </li>
    );
}

// The items of one workflow and its reset. `onChanged` reads the store again (the store's event does as well).
export function LearnedWorkflowBody({
    workflow,
    items,
    onChanged,
}: {
    workflow: string;
    items: LearningItem[];
    onChanged: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>(null);
    const reset = () =>
        fireAndForget(async () => {
            try {
                await learningReset(workflow);
                setConfirming(false);
                setError(null);
                onChanged();
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    if (items.length === 0) {
        return (
            <p className="px-5 py-3 text-12 text-muted" data-testid="learning-empty">
                {t("learning.empty", { workflow: workflowName(workflow, t) })}
            </p>
        );
    }
    return (
        <div data-testid="learning-workflow" data-workflow={workflow}>
            <ul className="flex flex-col">
                {items.map((item) => (
                    <ItemRow key={item.id} workflow={workflow} item={item} onChanged={onChanged} onError={setError} />
                ))}
            </ul>
            {error ? (
                <p className="px-5 pb-2 text-12 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 px-5 py-3">
                {confirming ? (
                    <>
                        <span className="min-w-0 flex-1 basis-60 text-12 text-secondary" role="alert">
                            {tCount("learning.reset.confirm", items.length)}
                        </span>
                        <button
                            type="button"
                            className={DangerButton}
                            onClick={reset}
                            data-testid="learning-reset-confirm"
                        >
                            {t("learning.reset.yes")}
                        </button>
                        <button type="button" className={GhostButton} onClick={() => setConfirming(false)}>
                            {t("learning.cancel")}
                        </button>
                    </>
                ) : (
                    <button
                        type="button"
                        className={SecondaryButton}
                        onClick={() => setConfirming(true)}
                        data-testid="learning-reset"
                    >
                        {t("learning.reset.button")}
                    </button>
                )}
            </div>
        </div>
    );
}

// In a workflow's view: folded to one line with the count, the list when opened. The learning is the workflow's own, so
// the developer sees what it remembers where it applies.
export function LearnedSection({
    workflow,
    className,
    hideWhenEmpty,
}: {
    workflow: string;
    className?: string;
    // Nothing to show yet: the view says nothing (Settings still lists the workflow).
    hideWhenEmpty?: boolean;
}) {
    const t = useT();
    const tCount = useTCount();
    const learned = useLearned(workflow);
    const [open, setOpen] = useState(false);
    if (!learned.ready || (hideWhenEmpty && learned.items.length === 0)) {
        return null;
    }
    return (
        <section
            className={cn("rounded-6 border border-border", className)}
            data-testid="learning-section"
            data-workflow={workflow}
        >
            <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-12"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                data-testid="learning-toggle"
            >
                <i className={`fa fa-solid fa-chevron-${open ? "down" : "right"} text-10 text-muted`} aria-hidden />
                <span className="font-medium text-primary">{t("learning.title")}</span>
                <span className="text-muted">{tCount("learning.count", learned.items.length)}</span>
            </button>
            {open ? (
                <div className="border-t border-border">
                    <p className="px-5 pt-3 text-11 text-muted">{t("learning.intro")}</p>
                    <LearnedWorkflowBody workflow={workflow} items={learned.items} onChanged={learned.reload} />
                </div>
            ) : null}
        </section>
    );
}
