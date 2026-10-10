// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Placeholder steps until #162 (agent), #163 (morph) and #165 (project) bring theirs: what the step is about, and the
// footer's Next to move on (FR-SHELL-053: a step never calls itself unfinished). The agent step stays hidden until
// #162 detects the agents (FirstRunStep.hidden).

import type { FirstRunStepContext } from "./onboarding-steps";

function PlaceholderStep({ lines }: { lines: string[] }) {
    return (
        <div className="flex flex-col gap-3 text-13 leading-5 text-secondary">
            {lines.map((line) => (
                <p key={line}>{line}</p>
            ))}
        </div>
    );
}

export function AgentPlaceholderStep(_props: { ctx: FirstRunStepContext }) {
    return (
        <PlaceholderStep
            lines={[
                "MoltenTerm looks for the coding agents installed on this machine (Claude Code, Codex, Gemini CLI and others) and starts the one you choose in a terminal next to this guide.",
            ]}
        />
    );
}

export function MorphPlaceholderStep(_props: { ctx: FirstRunStepContext }) {
    return (
        <PlaceholderStep
            lines={[
                "Ask your agent for a first change with /morph in a terminal: it writes a mod, MoltenTerm loads it, and molten undo takes it back.",
            ]}
        />
    );
}

export function ProjectPlaceholderStep(_props: { ctx: FirstRunStepContext }) {
    return (
        <PlaceholderStep
            lines={[
                "Link a workspace to your project folder from the Project tab or with molten project link: terminals start there, the Project tab shows where the project stands, and Sessions lists the agents still running.",
            ]}
        />
    );
}
