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

// A workspace still carrying the name MoltenTerm or Wave gave it is named after the project by default.
export function hasDefaultName(name: string): boolean {
    const value = (name ?? "").trim();
    return value === "" || value === "Starter workspace" || /^New Workspace\b/.test(value);
}
