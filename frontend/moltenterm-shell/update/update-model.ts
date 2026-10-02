// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the gold update shows (#64): the changes of the new build and the terminals a restart stops. Kept apart from
// the components so the rules can be tested without the app.

import type { GoldManifest, GoldNote } from "@/util/moltenterm-gold";

// Client meta keys, shared by every window: the build the user put off, and the build already announced.
export const UpdateSkippedMetaKey = "molten:update:skipped";
export const UpdateNotifiedMetaKey = "molten:update:notified";

export const UpdateCheckIntervalMs = 60_000;

export type NoteGroups = { features: GoldNote[]; fixes: GoldNote[]; other: GoldNote[] };

const TypeRegex = /^([a-z]+)(\([^)]*\))?!?:/;

export function groupNotes(notes: readonly GoldNote[]): NoteGroups {
    const groups: NoteGroups = { features: [], fixes: [], other: [] };
    for (const note of notes ?? []) {
        const type = TypeRegex.exec(note.subject ?? "")?.[1];
        if (type === "feat") {
            groups.features.push(note);
        } else if (type === "fix") {
            groups.fixes.push(note);
        } else {
            groups.other.push(note);
        }
    }
    return groups;
}

// The update is offered unless the user put this very build off; a newer one is offered again.
export function shouldOffer(manifest: GoldManifest, skipped: number): boolean {
    return manifest != null && !(skipped >= manifest.buildId);
}

export function updateLabel(manifest: GoldManifest): string {
    return `${manifest.commit?.slice(0, 7) ?? "?"} · build ${manifest.buildId}`;
}

export type RunningTerminal = { workspace: string; tab: string; command: string };

export type TerminalSummary = { total: number; running: RunningTerminal[] };

type TerminalSource = { workspace: string; tab: string; shellState: string; lastCommand: string };

export function summarizeTerminals(sources: readonly TerminalSource[]): TerminalSummary {
    return {
        total: sources.length,
        running: sources
            .filter((s) => s.shellState === "running-command")
            .map((s) => ({ workspace: s.workspace, tab: s.tab, command: s.lastCommand || "a command" })),
    };
}

export function restartWarning(summary: TerminalSummary): string {
    if (summary == null || summary.total === 0) {
        return "No terminal is open.";
    }
    const shells = summary.total === 1 ? "1 terminal" : `${summary.total} terminals`;
    if (summary.running.length === 0) {
        return `Restarting closes ${shells}; none is running a command.`;
    }
    const running =
        summary.running.length === 1 ? "1 is running a command" : `${summary.running.length} are running a command`;
    return `Restarting closes ${shells}, and ${running}:`;
}
