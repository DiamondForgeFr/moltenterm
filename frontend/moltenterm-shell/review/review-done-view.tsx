// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's header once its PR is finished (#686): a calm state in place of Validate, never a call to action.
// Validated (merged from MoltenTerm) reopens the Validate sheet's result; Merged on GitHub and Closed without merge only
// say what happened.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { deleteLayoutModelForTab } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useLocale, useT } from "../i18n/i18n";
import { closeTabAskingFirst } from "../worktree-close";
import { ReviewDone, reviewDoneDetail, reviewDoneLabel } from "./review-done";
import type { ReviewTabModel } from "./review-tab-model";

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
                onClick={() => model.openValidateResult()}
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

// Closes the Review tab, through the same path as the tab's own close (its panels' guards included).
export function CloseReviewTabButton({ model, className }: { model: ReviewTabModel; className: string }) {
    const t = useT();
    const onClick = () => {
        model.closeValidate();
        const workspaceId = globalStore.get(atoms.workspaceId);
        const tabId = globalStore.get(atoms.staticTabId);
        fireAndForget(async () => {
            if (await closeTabAskingFirst(getApi().closeTab, workspaceId, tabId, false)) {
                deleteLayoutModelForTab(tabId);
            }
        });
    };
    return (
        <button type="button" className={cn(className, "mr-auto")} onClick={onClick} data-testid="review-close-tab">
            {t("review.done.closeTab")}
        </button>
    );
}
