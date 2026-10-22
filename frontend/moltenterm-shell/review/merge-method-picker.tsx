// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merge method of every sheet that merges (FR-REV-012 AC2, FR-REV-025, #957): Validate and the batch modal show
// the same picker, preselected on the repository's remembered method, say the choice is the repository's default, and
// announce a remembered method GitHub no longer allows instead of replacing it silently.

import { useT } from "../i18n/i18n";
import { SegmentedControl } from "../segmented-control";
import { ReviewMergeMethod } from "./review-client";
import { mergeMethodNotes } from "./review-merge";

export function MergeMethodPicker({
    methods,
    defaultMethod,
    method,
    refused,
    queue,
    onSelect,
    testId,
}: {
    methods: ReviewMergeMethod[];
    defaultMethod: ReviewMergeMethod;
    method: ReviewMergeMethod;
    refused?: ReviewMergeMethod;
    queue?: boolean;
    onSelect?: (method: ReviewMergeMethod) => void;
    testId: string;
}) {
    const t = useT();
    const notes = mergeMethodNotes(defaultMethod, method, refused, queue ?? false);
    const choosable = !queue && onSelect != null && (methods?.length ?? 0) > 1;
    const segments = (methods ?? []).map((m) => ({
        value: m,
        label: t(`review.validate.method.${m}`),
        title: t(`review.validate.methodTitle.${m}`),
    }));
    return (
        <div className="mt-1 mb-1 flex flex-col gap-1" data-testid={testId} data-method={method}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-12 text-secondary">{t("review.validate.methodLabel")}</span>
                {choosable ? (
                    <SegmentedControl
                        label={t("review.validate.methodLabel")}
                        segments={segments}
                        selected={method}
                        onSelect={onSelect}
                    />
                ) : (
                    <span
                        className="text-12 font-medium text-primary"
                        title={t(`review.validate.methodTitle.${method}`)}
                    >
                        {t(`review.validate.method.${method}`)}
                    </span>
                )}
                <span className="text-11 text-muted" data-testid={`${testId}-hint`}>
                    {notes.hint}
                </span>
            </div>
            {notes.refused ? (
                <p
                    className="rounded-4 border border-warning/40 bg-warning/10 px-2 py-1 text-11 text-warning"
                    role="status"
                    data-testid={`${testId}-refused`}
                >
                    {notes.refused}
                </p>
            ) : null}
        </div>
    );
}
