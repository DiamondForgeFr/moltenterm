// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a project's Integration view shows under its pull requests (FR-REV-001, FR-SHELL-087): the line saying none is
// open, then Coming, Notes and Recently merged, each with its own empty text. The single-project view and each
// project's block in All projects draw them from here, so the two views cannot drift apart (#2291).

import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { MergedSection } from "./reviews-merged";
import type { ReviewsAnswer } from "./reviews-model";
import { NotesAsk, NotesSection } from "./reviews-notes-view";
import { ReviewsFolds } from "./reviews-order-store";
import type { ScopeNames } from "./reviews-owners-model";
import { UpcomingSection } from "./reviews-upcoming";

// No pull request listed: none is open into the trunk, or the view's filter hides the ones that are.
export function NoneOpenLine({ target, hidden }: { target: string; hidden: boolean }) {
    const t = useT();
    return (
        <p
            className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
            data-testid="reviews-none-open"
        >
            {hidden ? (
                t("reviews.owners.noneShown")
            ) : (
                <>
                    {t("reviews.sections.none")} <code>{target}</code>.
                </>
            )}
        </p>
    );
}

export function ProjectTail({
    dir,
    answer,
    blockId,
    names,
    defaultOpen = true,
}: {
    dir: string;
    answer: ReviewsAnswer;
    blockId: string;
    names: ScopeNames;
    defaultOpen?: boolean;
}) {
    // "Show notes" on a merged pull request filters the Notes right above it.
    const [notesAsk, setNotesAsk] = useState<NotesAsk>(null);
    useEffect(() => {
        if (notesAsk != null) {
            ReviewsFolds.getInstance().openForNow(dir, "notes");
        }
    }, [notesAsk, dir]);
    return (
        <>
            <UpcomingSection dir={dir} reviews={answer} defaultOpen={defaultOpen} names={names} />
            {answer.repo ? (
                <NotesSection dir={dir} repo={answer.repo} blockId={blockId} ask={notesAsk} defaultOpen={defaultOpen} />
            ) : null}
            {answer.repo ? (
                <MergedSection
                    answer={answer}
                    defaultOpen={defaultOpen}
                    onShowNotes={(filter) => setNotesAsk({ filter, at: Date.now() })}
                />
            ) : null}
        </>
    );
}
