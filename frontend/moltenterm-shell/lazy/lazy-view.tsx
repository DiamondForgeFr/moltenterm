// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Lean renderer bundle (FR-PERF-007, DS-PERF-006): heavy libraries load at the view that needs them, through
// React.lazy, so the entry every tab view evaluates stays small. The build fails if one of them reaches the entry
// again (frontend/moltenterm-shell/build/entry-guard.ts).

import { cn } from "@/util/util";

export function LazyViewLoading({ label, className }: { label: string; className?: string }) {
    return (
        <div
            className={cn("flex h-full w-full items-center justify-center text-12 text-muted select-none", className)}
            data-testid="lazy-view-loading"
        >
            {label}
        </div>
    );
}
