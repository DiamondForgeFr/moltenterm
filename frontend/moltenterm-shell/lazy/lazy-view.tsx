// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Lean renderer bundle (FR-PERF-007, DS-PERF-006): heavy libraries load at the view that needs them, through
// React.lazy, so the entry every tab view evaluates stays small. The build fails if one of them reaches the entry
// again (frontend/moltenterm-shell/build/entry-guard.ts).

import { cn } from "@/util/util";
import { LoadingState } from "../suite/suite";

export function LazyViewLoading({ label, className }: { label: string; className?: string }) {
    return (
        <LoadingState
            caption={label}
            className={cn("h-full w-full select-none", className)}
            testId="lazy-view-loading"
        />
    );
}
