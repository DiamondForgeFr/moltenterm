// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a workflow view shows of its learning (FR-LRN-002): the mark on an answer prefilled from the developer's earlier
// choices, and a step the developer always skips, folded to one calm row and never removed.

import { cn } from "@/util/util";
import { useState } from "react";
import { useT } from "../i18n/i18n";

// 'd'après vos choix précédents': beside a field the learning filled in. It goes when the developer changes the field.
export function PrefillMark({ className }: { className?: string }) {
    const t = useT();
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center rounded-4 border border-border px-1.5 py-0.5 text-10 text-muted",
                className
            )}
            title={t("learning.prefill.title")}
            data-testid="learning-prefill-mark"
        >
            {t("learning.prefill.mark")}
        </span>
    );
}

// A step the developer skipped in the last runs in a row. Folded it is one row with a way to open it; opened, or not
// folded, it is the step as it always was. The panel never blocks: nothing here skips the step for the developer.
export function FoldedStep({
    folded,
    title,
    children,
    testId,
}: {
    folded: boolean;
    title: string;
    children: React.ReactNode;
    testId?: string;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    if (!folded || open) {
        return <>{children}</>;
    }
    return (
        <div
            className="flex items-center gap-2 rounded-4 border border-dashed border-border px-2.5 py-1.5 text-12 text-muted"
            data-testid={testId ?? "learning-folded-step"}
        >
            <span className="min-w-0 flex-1 truncate text-secondary">{title}</span>
            <span className="shrink-0 text-11">{t("learning.folded.hint")}</span>
            <button
                type="button"
                className="molten-btn-ghost shrink-0 cursor-pointer rounded-4 px-2 py-0.5 text-12"
                aria-expanded={false}
                onClick={() => setOpen(true)}
            >
                {t("learning.folded.show")}
            </button>
        </div>
    );
}
