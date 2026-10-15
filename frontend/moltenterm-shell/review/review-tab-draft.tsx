// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A draft's Review tab (#687): the AI analysis works as on any PR, Validate waits with its reason, and Mark ready for
// review moves the PR to review from the header, with the same confirmation as the Reviews list's row.

import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import { MarkReadyButton, MarkReadyConfirm, useMarkReady } from "../reviews/reviews-mark-ready";
import { ReviewTabModel } from "./review-tab-model";

export function DraftActions({ model }: { model: ReviewTabModel }) {
    const t = useT();
    const pr = useAtomValue(model.prAtom);
    const state = useMarkReady(pr?.dir, pr?.number, pr?.repo);
    const reason = t("reviews.validate.draft");
    return (
        <>
            <span
                className="inline-flex h-6 items-center gap-1 rounded-4 border border-border bg-hover px-1.5 text-11 whitespace-nowrap text-muted"
                title={t("reviews.ready.draftChipTitle")}
                data-testid="review-draft"
            >
                <i className="fa fa-solid fa-pen-ruler text-11" />
                {t("reviews.ready.draftChip")}
            </span>
            <div className="relative">
                <MarkReadyButton state={state} className="h-6 px-2" />
                {state.phase === "idle" ? null : (
                    <MarkReadyConfirm
                        state={state}
                        className="absolute top-full right-0 z-10 mt-1.5 w-80 rounded-10 border border-line-strong bg-surface-3 p-2.5 shadow-e2"
                    />
                )}
            </div>
            <button
                type="button"
                aria-disabled
                className="flex h-6 cursor-default items-center gap-1.5 rounded-6 border border-border px-2 text-12 text-muted opacity-60"
                title={reason}
                aria-label={`${t("review.validate.button")}: ${reason}`}
                data-testid="review-validate"
            >
                <i className="fa fa-solid fa-code-merge text-11" />
                {t("review.validate.button")}
            </button>
        </>
    );
}
