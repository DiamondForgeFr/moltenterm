// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The questions Brokk's talk window asks about the brainstorms (FR-BOSS-010 AC10a to AC10d, #2248): the picker on entry,
// the near-duplicate of `/brainstorm <idea>`, his offer to resume one, and the confirmation of a forget. Each acts only on
// the developer's click: his offer never opens anything, and a forget is sent only from the confirm button, after its
// title and last change were shown. Loaded on demand (brokk-talk.tsx), the first time a question is asked.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useLocale, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { lastChange } from "./brainstorm-model";
import { BrainstormModel, BrainstormSummary } from "./brainstorm-store";

const Card = "flex flex-col gap-1.5 rounded-4 border border-border p-2 text-12";
const Primary = "molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11";
const Secondary = "cursor-pointer rounded-4 border border-border px-2 py-0.5 text-11 text-primary hover:bg-hover";

// The question before a forget, in his talk window and in the widget: the title, its last change, and the two answers.
export function ForgetConfirm({
    summary,
    busy,
    onConfirm,
    onCancel,
}: {
    summary: BrainstormSummary;
    busy: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const t = useT();
    const locale = useLocale();
    return (
        <div
            role="alertdialog"
            aria-label={t("boss.brainstorm.forget.label")}
            className={Card}
            data-testid="brainstorm-forget"
        >
            <span className="text-primary">{t("boss.brainstorm.forget.ask", { title: summary.title })}</span>
            <span className="text-11 text-secondary" data-testid="brainstorm-forget-detail">
                {t("boss.brainstorm.forget.detail", { when: lastChange(summary.updated, locale) })}
            </span>
            <span className="inline-flex flex-wrap justify-end gap-1.5">
                <button
                    type="button"
                    disabled={busy}
                    className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-2 py-0.5 text-11"
                    data-testid="brainstorm-forget-confirm"
                    onClick={onConfirm}
                >
                    {t("boss.brainstorm.forget.confirm")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    disabled={busy}
                    className={Secondary}
                    data-testid="brainstorm-forget-cancel"
                    onClick={onCancel}
                >
                    {t("boss.brainstorm.forget.cancel")}
                </button>
            </span>
        </div>
    );
}

export function BrainstormPrompts({ name }: { name: string }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormModel.getInstance();
    const prompt = useAtomValue(model.promptAtom, { store: globalStore });
    const [busy, setBusy] = useState(false);
    if (prompt == null) {
        return null;
    }
    const run = (action: () => unknown) => async () => {
        if (busy) {
            return;
        }
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    };
    if (prompt.kind === "forget") {
        return (
            <ForgetConfirm
                summary={prompt.match}
                busy={busy}
                onConfirm={run(() => model.forgetFolder(prompt.match.slug))}
                onCancel={() => model.dismissPrompt()}
            />
        );
    }
    if (prompt.kind === "picker") {
        return (
            <div
                role="group"
                aria-label={t("boss.brainstorm.picker.label", { name })}
                className={Card}
                data-testid="brainstorm-picker"
            >
                <span className="text-secondary">{t("boss.brainstorm.picker.ask", { name })}</span>
                <span className="inline-flex flex-wrap gap-1.5">
                    {prompt.recent.map((entry, i) => (
                        <button
                            key={entry.slug}
                            type="button"
                            disabled={busy}
                            className={i === 0 ? Primary : Secondary}
                            data-testid="brainstorm-picker-resume"
                            data-slug={entry.slug}
                            title={t("boss.brainstorm.lastChange", { when: lastChange(entry.updated, locale) })}
                            onClick={run(() => model.load(entry.slug))}
                        >
                            {t("boss.brainstorm.picker.resume", { title: entry.title })}
                            {i === 0 ? <MoltenWave /> : null}
                        </button>
                    ))}
                    <button
                        type="button"
                        disabled={busy}
                        className={Secondary}
                        data-testid="brainstorm-picker-new"
                        onClick={run(() => model.newIdea())}
                    >
                        {t("boss.brainstorm.newIdea")}
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        className={Secondary}
                        data-testid="brainstorm-picker-all"
                        onClick={() => model.showAll()}
                    >
                        {t("boss.brainstorm.picker.all", { count: prompt.total })}
                    </button>
                </span>
            </div>
        );
    }
    const match = prompt.match;
    const duplicate = prompt.kind === "duplicate";
    return (
        <div
            role="group"
            aria-label={t("boss.brainstorm.offer.label", { name })}
            className={Card}
            data-testid={duplicate ? "brainstorm-duplicate" : "brainstorm-offer"}
        >
            <span className="text-primary">
                {duplicate
                    ? t("boss.brainstorm.duplicate.ask", { title: match.title })
                    : t("boss.brainstorm.offer.ask", { title: match.title })}
            </span>
            <span className="text-11 text-secondary">
                {t("boss.brainstorm.lastChange", { when: lastChange(match.updated, locale) })}
            </span>
            <span className="inline-flex flex-wrap justify-end gap-1.5">
                <button
                    type="button"
                    disabled={busy}
                    className={Primary}
                    data-testid="brainstorm-prompt-resume"
                    onClick={run(() => model.load(match.slug))}
                >
                    {t("boss.brainstorm.resumeAction")}
                    <MoltenWave />
                </button>
                {duplicate ? (
                    <button
                        type="button"
                        disabled={busy}
                        className={Secondary}
                        data-testid="brainstorm-prompt-fresh"
                        onClick={run(() => model.startFresh(prompt.idea))}
                    >
                        {t("boss.brainstorm.duplicate.fresh")}
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={busy}
                        className={Secondary}
                        data-testid="brainstorm-prompt-later"
                        onClick={() => model.dismissPrompt()}
                    >
                        {t("boss.brainstorm.offer.later")}
                    </button>
                )}
            </span>
        </div>
    );
}
