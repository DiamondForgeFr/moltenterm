// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A search engine's mark (#2312): its letters on a tile of the shell's tokens. The list of engines is shown without a
// network call, so no favicon is fetched; the engine's name always sits next to the mark.

import { cn } from "@/util/util";

export function EngineMark({ letters, className }: { letters: string; className?: string }) {
    return (
        <span
            aria-hidden
            data-role="engine-mark"
            className={cn(
                "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-4 border border-border bg-surface-3 px-0.5 text-11 font-semibold text-secondary",
                className
            )}
        >
            {letters}
        </span>
    );
}
