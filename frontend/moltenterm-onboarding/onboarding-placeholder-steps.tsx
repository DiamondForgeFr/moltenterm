// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Placeholder steps until #162 (agent), #163 (morph) and #165 (project) bring theirs: one paragraph on what the step
// is about (the panel leaves the step's summary out for them, it would say the same), and the footer's Next to move
// on (FR-SHELL-053: a step never calls itself unfinished). The agent step stays hidden until #162 detects the agents
// (FirstRunStep.hidden).

import type { FirstRunStepContext } from "./onboarding-steps";

function Code({ children }: { children: React.ReactNode }) {
    return <code className="font-mono text-12 text-primary">{children}</code>;
}

function PlaceholderStep({ children }: { children: React.ReactNode }) {
    return <p className="text-13 leading-5 text-secondary">{children}</p>;
}

export function AgentPlaceholderStep(_props: { ctx: FirstRunStepContext }) {
    return (
        <PlaceholderStep>
            MoltenTerm looks for the coding agents installed on this machine (Claude Code, Codex, Gemini CLI and others)
            and starts the one you choose in a terminal next to this guide.
        </PlaceholderStep>
    );
}

export function MorphPlaceholderStep(_props: { ctx: FirstRunStepContext }) {
    return (
        <PlaceholderStep>
            In your agent&apos;s terminal, type <Code>/morph</Code> and the change you want: the agent writes a mod,
            MoltenTerm loads it, and <Code>molten undo</Code> takes it back.
        </PlaceholderStep>
    );
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
