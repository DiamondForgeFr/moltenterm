// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The project's mark on each card of Integration's All projects (#2314, FR-SHELL-087): a compact chip with the project's
// name, the branch its pull requests target, and the place colour of the workspace when it has one. A click shows that
// project alone, as its chip at the top of the panel does. Cards are marked here only: a project's own view shows none.

import { cn } from "@/util/util";
import { useT } from "../i18n/i18n";
import type { ProjectMarkFacts } from "./reviews-all-model";

// The click of a mark shows that project alone and goes no further: the card under it keeps its own action.
export function chooseProject(
    e: { stopPropagation: () => void },
    projectId: string,
    onChoose: (projectId: string) => void
) {
    e.stopPropagation();
    onChoose(projectId);
}

export function ProjectMark({
    facts,
    onChoose,
    className,
}: {
    facts: ProjectMarkFacts;
    onChoose: (projectId: string) => void;
    className?: string;
}) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={(e) => chooseProject(e, facts.id, onChoose)}
            onKeyDown={(e) => e.stopPropagation()}
            title={
                facts.target
                    ? t("reviews.projects.markTitleInto", { project: facts.label, target: facts.target })
                    : t("reviews.projects.markTitle", { project: facts.label })
            }
            className={cn(
                "inline-flex h-[18px] max-w-[14rem] shrink-0 cursor-pointer items-center gap-1 rounded-full border-0 bg-white/[0.08] px-1.5 text-11 leading-none font-normal whitespace-nowrap text-secondary transition-colors duration-120 ease-mt hover:bg-white/[0.14] hover:text-primary",
                className
            )}
            data-testid="reviews-project-mark"
            data-project={facts.id}
        >
            {facts.place ? (
                <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mt-place)]"
                    aria-hidden
                    data-testid="reviews-project-mark-place"
                />
            ) : null}
            <span className="min-w-0 truncate">{facts.label}</span>
            {facts.target ? (
                <span className="min-w-0 truncate text-muted" data-testid="reviews-project-mark-target">
                    {t("reviews.projects.markInto", { target: facts.target })}
                </span>
            ) : null}
        </button>
    );
}
