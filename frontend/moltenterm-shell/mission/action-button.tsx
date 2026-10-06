// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The look of the Project header's actions (FR-MC-021): Run CI on develop is the molten primary, Build local, Release
// and Clean branches are calm bordered secondaries of the same size, and an action under way reads as running.

import { cn } from "@/util/util";

export const ActionPrimaryClass =
    "molten-btn flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap disabled:cursor-default disabled:opacity-50";

export const ActionSecondaryClass =
    "flex cursor-pointer items-center gap-2 rounded border border-border px-3 py-1.5 text-xs whitespace-nowrap text-secondary transition-colors hover:border-secondary/40 hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

export const ActionRunningClass =
    "flex cursor-pointer items-center gap-2 rounded border border-accent/50 px-3 py-1.5 text-xs whitespace-nowrap text-primary transition-colors hover:bg-hover";

// The pulsing dot of an action under way, in steps (mt-step-ping in moltenterm-shell.css); still under reduced motion
// (the media query and MoltenTerm's setting).
export function RunningDot({ className }: { className?: string }) {
    return (
        <span className={cn("relative flex h-1.5 w-1.5 text-accent", className)} aria-hidden>
            <span className="mt-step-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-0" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
    );
}
