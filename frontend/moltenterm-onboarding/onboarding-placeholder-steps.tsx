// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The placeholder step until #165 (project) brings its own: one paragraph on what the step is about (the panel leaves
// the step's summary out for it, it would say the same), and the footer's Next to move on (FR-SHELL-053: a step never
// calls itself unfinished).

import type { FirstRunStepContext } from "./onboarding-steps";

function Code({ children }: { children: React.ReactNode }) {
    return <code className="font-mono text-12 text-primary">{children}</code>;
}

function PlaceholderStep({ children }: { children: React.ReactNode }) {
    return <p className="text-13 leading-5 text-secondary">{children}</p>;
}

export function ProjectPlaceholderStep(_props: { ctx: FirstRunStepContext }) {
    return (
        <PlaceholderStep>
            Link this workspace to your project folder from the Project tab or with <Code>molten project link</Code>:
            terminals start there, the Project tab shows where the project stands, and Sessions lists the agents still
            running.
        </PlaceholderStep>
    );
}
