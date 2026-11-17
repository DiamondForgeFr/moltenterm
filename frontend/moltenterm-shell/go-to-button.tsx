// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration panel's "Go to →" (the agent bar of FR-REV-022, #712), one component for every surface that takes the
// developer to an agent or to where something comes from, so that the Integration panel and the cards of Brokk's
// Notifications panel (#2195) read the same.

import { cn } from "@/util/util";
import { useT } from "./i18n/i18n";

export const BarButton =
    "flex h-5 shrink-0 cursor-pointer items-center gap-1.5 rounded-4 border border-transparent px-1.5 text-secondary hover:border-border hover:bg-hover hover:text-primary focus-visible:border-border";

// The control keeps its click and keys: the row or tile it sits in opens something else on its own click.
function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

export function GoToButton({
    title,
    testId,
    className,
    onClick,
}: {
    title?: string;
    testId: string;
    className?: string;
    onClick: (e: React.MouseEvent) => void;
}) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onClick(e);
            }}
            onKeyDown={stop}
            className={cn(BarButton, className)}
            title={title}
            data-testid={testId}
        >
            {t("reviewsAgents.goTo")}
            <i className="fa fa-solid fa-arrow-right text-10" aria-hidden />
        </button>
    );
}
