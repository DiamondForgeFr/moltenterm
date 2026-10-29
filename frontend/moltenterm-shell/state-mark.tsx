// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The state mark (FR-SHELL-116): one shape per state, in its heat colour (moltenterm-shell.css, .mt-state-mark), so a
// state never rests on its colour alone. A running arc holds the working beat while it shows, which turns it a quarter
// per beat; without the beat it stands still.

import { cn } from "@/util/util";
import { useWorkingBeat } from "./working-beat";

export const StateMarkKinds = ["blocked", "running", "ready", "draft", "waiting"] as const;

export type StateMarkKind = (typeof StateMarkKinds)[number];

// label: the state's accessible name, when no text next to the mark already says it; without it the mark is hidden
// from assistive technologies.
export function StateMark({
    kind,
    label,
    className,
    testId,
}: {
    kind: StateMarkKind;
    label?: string;
    className?: string;
    testId?: string;
}) {
    const running = kind === "running";
    useWorkingBeat(running);
    return (
        <span
            className={cn("mt-state-mark", `is-${kind}`, running && "mt-beat-turn", className)}
            role={label ? "img" : undefined}
            aria-label={label || undefined}
            title={label || undefined}
            aria-hidden={label ? undefined : true}
            data-state={kind}
            data-testid={testId}
        />
    );
}
