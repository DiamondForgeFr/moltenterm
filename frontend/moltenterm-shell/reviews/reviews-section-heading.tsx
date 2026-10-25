// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A Reviews section's heading (#1061, FR-REV-001 AC12): a fold chevron, the title, its count and a short muted hint,
// with the section's own actions at the end of the line. Every section of the panel shares it, so they read as one
// list of blocks.

import { cn } from "@/util/util";

export function SectionHeading({
    title,
    count,
    hint,
    open,
    onToggle,
    testId,
    children,
}: {
    title: string;
    count?: number | string;
    hint?: React.ReactNode;
    open: boolean;
    onToggle: () => void;
    testId?: string;
    // The section's own actions, on the heading line.
    children?: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button
                type="button"
                onClick={onToggle}
                onKeyDown={(e) => e.stopPropagation()}
                aria-expanded={open}
                className="flex min-w-0 cursor-pointer items-baseline gap-1.5 rounded-4 text-left text-13 leading-5 font-semibold hover:text-primary"
                data-testid={testId}
            >
                <i
                    className={cn(
                        "fa fa-solid fa-chevron-right w-2.5 self-center text-10 text-muted transition-transform duration-120 ease-mt",
                        open && "rotate-90"
                    )}
                    aria-hidden
                />
                <span className="min-w-0 truncate">{title}</span>
                {count != null && count !== "" ? (
                    <span className="shrink-0 text-12 font-normal text-muted tabular-nums">{count}</span>
                ) : null}
                {hint ? <span className="min-w-0 truncate text-11 font-normal text-muted">{hint}</span> : null}
            </button>
            {children != null ? <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div> : null}
        </div>
    );
}
