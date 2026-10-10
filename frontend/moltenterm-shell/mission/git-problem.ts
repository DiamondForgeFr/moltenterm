// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Why Mission Control could not read a project's history, from the collector's git error (FR-SHELL-053): the panel
// says it in plain words and keeps git's own output under Details.

export type GitProblem = "notrepo" | "nogit" | "other";

export function gitProblem(gitError: string): GitProblem {
    const text = (gitError ?? "").toLowerCase();
    if (text.includes("not a git repository")) {
        return "notrepo";
    }
    // pkg/molten/mission/run.go MissingProgramError
    if (text.startsWith("git is not installed")) {
        return "nogit";
    }
    return "other";
}

export type FolderEntry = { name: string; isDir: boolean };

// Folders first, then files, each by name; dot entries last, as a file manager shows them.
export function sortFolderEntries(entries: FolderEntry[]): FolderEntry[] {
    return [...(entries ?? [])].sort((a, b) => {
        if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
        }
        const ad = a.name.startsWith(".");
        const bd = b.name.startsWith(".");
        if (ad !== bd) {
            return ad ? 1 : -1;
        }
        return a.name.localeCompare(b.name);
    });
}
