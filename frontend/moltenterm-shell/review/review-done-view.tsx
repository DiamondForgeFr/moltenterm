// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's header once its PR is finished (#686): a calm state in place of Validate, never a call to action.
// Validated (merged from MoltenTerm) reopens the Validate sheet's result; Merged on GitHub and Closed without merge only
// say what happened.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useLocale, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { MergedFooter, ReviewDone, reviewDoneDetail, reviewDoneLabel } from "./review-done";
import type { ReviewTabModel } from "./review-tab-model";
import type { ReviewValidateModel } from "./review-validate-model";

const DoneChip = "flex h-6 items-center gap-1.5 rounded-4 border px-2 text-12 whitespace-nowrap";

function doneTone(done: ReviewDone): string {
    return done.kind === "closed" ? "border-border text-secondary" : "border-success/40 bg-success/10 text-success";
}

export function ReviewDoneState({ model }: { model: ReviewTabModel }) {
    const t = useT();
    const locale = useLocale();
    const done = useAtomValue(model.doneAtom);
    const label = reviewDoneLabel(t, done);
    const title = reviewDoneDetail(t, done, locale);
    const icon = done.kind === "closed" ? "fa-circle-minus" : "fa-circle-check";
    if (done.kind === "merged") {
        return (
            <button
                type="button"
                className={cn(DoneChip, doneTone(done), "cursor-pointer hover:bg-success/15")}
                onClick={() => model.validator.openValidateResult()}
                title={title}
                data-testid="review-done"
                data-state={done.kind}
            >
                <i className={cn("fa fa-solid text-11", icon)} />
                {label}
            </button>
        );
    }
    return (
        <span
            className={cn(DoneChip, doneTone(done))}
            title={title}
            role="status"
            data-testid="review-done"
            data-state={done.kind}
        >
            <i className={cn("fa fa-solid text-11", icon)} />
            {label}
        </span>
    );
}

// The Validate result's footer once the PR is merged (#686): the tab has done its job, so closing it is the primary
// action, focused so Enter takes it; Keep it open only closes the sheet. With no Review tab (a Reviews row's Validate,
// #707), there is no tab to ask about: Done closes the sheet.
export function MergedFooterButtons({
    model,
    footer,
    plainClass,
}: {
    model: ReviewValidateModel;
    footer: MergedFooter;
    plainClass: string;
}) {
    const t = useT();
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        closeRef.current?.focus();
    }, []);
    if (!model.host.inTab) {
        return (
            <>
                <span
                    className="mr-auto min-w-0 text-12 text-secondary"
                    data-testid="review-merged-line"
                    data-state={footer}
                >
                    {t(`review.done.footerSheet.${footer}`)}
                </span>
                <button
                    ref={closeRef}
                    type="button"
                    className="molten-btn flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-3 py-1 text-12 whitespace-nowrap"
                    onClick={() => model.closeValidate()}
                    data-testid="review-merged-done"
                >
                    {t("review.done.done")}
                    <MoltenWave />
                </button>
            </>
        );
    }
    return (
        <>
            <span
                className="mr-auto min-w-0 text-12 text-secondary"
                data-testid="review-merged-line"
                data-state={footer}
            >
                {t(`review.done.footer.${footer}`)}
            </span>
            <button
                type="button"
                className={cn(plainClass, "shrink-0 whitespace-nowrap")}
                onClick={() => model.closeValidate()}
                data-testid="review-keep-tab"
            >
                {t("review.done.keepOpen")}
            </button>
            <button
                ref={closeRef}
                type="button"
                className="molten-btn flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-3 py-1 text-12 whitespace-nowrap"
                onClick={() => model.closeValidateAndTab()}
                data-testid="review-close-tab"
            >
                {t("review.done.closeTab")}
                <MoltenWave />
            </button>
        </>
    );
}
