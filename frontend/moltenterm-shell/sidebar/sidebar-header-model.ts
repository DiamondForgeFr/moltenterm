// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { checkPathInside, ProjectLogoMetaKey, projectLogoOf, readWorkspaceProject } from "../workspace-project";
import { currentProject, readProjects } from "./workspace-projects";

// The project's logo at the left of the workspace title (#1278): the one the workspace keeps for its linked project,
// "" when it has none, and then nothing stands in its place.
export function workspaceHeaderLogo(ws: Workspace): string {
    const logo = (ws?.meta as Record<string, unknown>)?.[ProjectLogoMetaKey];
    return typeof logo === "string" ? logo.trim() : "";
}

// The icon at the left of the workspace title (FR-SHELL-087, #1760). A workspace with two projects or more shows the
// current project's own logo, so the developer sees at a glance which project is current: the logo chosen for that
// project in its Project sheet (kept in its entry), else the one the workspace keeps when it is inside the project's
// folder, else the first image found in the folder. A project without a logo shows the workspace's icon. A workspace
// with one project keeps the title's logo as it was.
export type HeaderIcon = { kind: "logo"; logo: string } | { kind: "workspace" } | { kind: "none" };

export function headerIcon(ws: Workspace, found: readonly string[]): HeaderIcon {
    if (readProjects(ws).length < 2) {
        const logo = workspaceHeaderLogo(ws);
        return logo !== "" ? { kind: "logo", logo } : { kind: "none" };
    }
    const current = currentProject(ws);
    const chosen = current?.logo ?? "";
    if (chosen !== "" && checkPathInside(chosen, current.dir)) {
        return { kind: "logo", logo: chosen };
    }
    const logo = projectLogoOf(readWorkspaceProject(ws), current?.dir ?? "", found);
    return logo !== "" ? { kind: "logo", logo } : { kind: "workspace" };
}
