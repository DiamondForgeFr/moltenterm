// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// When MoltenTerm offers to link a project (#77): a terminal of a workspace without a project goes into a project's
// folder, or a workspace was linked without choosing its icon. Kept apart from the components so the rules can be
// tested without the app.

import type { WorkspaceProject } from "./workspace-project";

// The project folders the user answered "Not now" for, in this workspace's meta.
export const ProjectDismissedMetaKey = "molten:projectdismissed";

export type ProjectOffer = { mode: "link" | "logo"; dir: string };

export function readDismissed(meta: Record<string, any>): string[] {
    const value = meta?.[ProjectDismissedMetaKey];
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

export function withDismissed(dismissed: readonly string[], dir: string): string[] {
    return dismissed.includes(dir) ? [...dismissed] : [...dismissed, dir];
}

// Linking is offered for a project found from a terminal, when the workspace has none; choosing the icon, once, when
// the workspace has a project and still its own icon.
export function nextProjectOffer(
    project: WorkspaceProject,
    terminalProject: string,
    dismissed: readonly string[],
    home: string
): ProjectOffer {
    if (project.dir === "") {
        if (!terminalProject || terminalProject === home || dismissed.includes(terminalProject)) {
            return null;
        }
        return { mode: "link", dir: terminalProject };
    }
    if (project.logo === "" && project.logoOffer !== project.dir) {
        return { mode: "logo", dir: project.dir };
    }
    return null;
}

function normalizePath(path: string): string {
    const parts: string[] = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return "/" + parts.join("/");
}

// The project a terminal's repository offers (#134). A linked worktree's .git file names its admin folder,
// <repository>/.git/worktrees/<name>: the project is the main checkout the worktree belongs to, not the worktree. A
// submodule (.git/modules/<name>), a bare repository's worktree or an unreadable file keep the folder.
export function projectOfGitFile(root: string, gitFile: string): string {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile ?? "");
    if (match == null || !root.startsWith("/")) {
        return root;
    }
    const gitDir = normalizePath(match[1].startsWith("/") ? match[1] : `${root}/${match[1]}`);
    const parts = gitDir.split("/");
    if (parts.length < 4 || parts[parts.length - 2] !== "worktrees" || parts[parts.length - 3] !== ".git") {
        return root;
    }
    return parts.slice(0, parts.length - 3).join("/") || "/";
}

// A workspace still carrying the name MoltenTerm or Wave gave it is named after the project by default.
export function hasDefaultName(name: string): boolean {
    const value = (name ?? "").trim();
    return value === "" || value === "Starter workspace" || /^New Workspace\b/.test(value);
}
