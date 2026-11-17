// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the launch bar and the launch dialogs share (FR-REV-031): their button and field classes and the mark of a step.

import { cn } from "@/util/util";
import { DominoLoader } from "../suite/suite";

export const SecondaryButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";
export const SmallButton =
    "flex shrink-0 cursor-pointer items-center gap-1 rounded-4 border border-border px-1.5 py-0.5 text-11 leading-4 text-secondary hover:bg-hover hover:text-primary";
export const Input =
    "min-w-0 rounded-4 border border-border bg-transparent px-1.5 py-1 text-12 text-primary outline-none focus:border-accent";

const StepIcon: Record<string, string> = {
    pending: "fa-circle text-muted",
    done: "fa-check text-success",
    failed: "fa-xmark text-danger",
    stopped: "fa-stop text-muted",
};

// The suite's dominoes are the one working indicator (#739).
export function StepMark({ state }: { state: string }) {
    if (state === "running") {
        return <DominoLoader />;
    }
    return <i className={cn("fa fa-solid text-10", StepIcon[state])} aria-hidden />;
}
