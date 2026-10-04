// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Placeholder steps until #162 (agent), #163 (morph) and #165 (project) bring theirs: what the step will do, and the
// host's "Skip this step" as the only way on.

import type { FirstRunStepContext } from "./onboarding-steps";

function PlaceholderStep({ lines }: { lines: string[] }) {
    return (
        <div className="flex flex-col gap-3 text-[13px] leading-5 text-secondary">
            {lines.map((line) => (
                <p key={line}>{line}</p>
            ))}
            <p className="rounded border border-border px-3 py-2 text-xs text-muted">
                This step is not ready in this version yet. Skip it for now: Getting started brings you back to it
                later.
            </p>
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
                "You ask your agent for a first change with /morph. It writes a mod, MoltenTerm loads it, and molten undo takes it back.",
            ]}
        />
    );
}

export function ProjectPlaceholderStep(_props: { ctx: FirstRunStepContext }) {
    return (
        <PlaceholderStep
            lines={[
                "You link this workspace to your project folder, so terminals start there and the Project tab shows where it stands, then find the agent sessions you already have.",
            ]}
        />
    );
}
