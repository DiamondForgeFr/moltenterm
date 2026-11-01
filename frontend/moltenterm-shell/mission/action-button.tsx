// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The look of the Project header's actions (FR-MC-021): Run CI on develop is the molten primary, Build local, Release
// and Clean branches are calm bordered secondaries of the same size, and an action under way reads as running.

import { cn } from "@/util/util";
import { DominoLoader } from "../suite/suite";

export const ActionPrimaryClass =
    "molten-btn flex cursor-pointer items-center gap-2 rounded-6 px-3 py-1.5 text-12 font-medium whitespace-nowrap disabled:cursor-default disabled:opacity-50";

export const ActionSecondaryClass =
    "flex cursor-pointer items-center gap-2 rounded-6 border border-border px-3 py-1.5 text-12 whitespace-nowrap text-secondary transition-colors duration-120 ease-mt hover:border-secondary/40 hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

export const ActionRunningClass =
    "flex cursor-pointer items-center gap-2 rounded-6 border border-accent/50 px-3 py-1.5 text-12 whitespace-nowrap text-primary transition-colors duration-120 ease-mt hover:bg-hover";

// The sign of an action under way: the inline dominoes in the accent (DS-SHELL-154, #1714; it was a pulsing dot). They
// stand still under reduced motion (the media query and MoltenTerm's setting).
export function RunningDot({ className }: { className?: string }) {
    return <DominoLoader className={cn("text-accent", className)} />;
}
