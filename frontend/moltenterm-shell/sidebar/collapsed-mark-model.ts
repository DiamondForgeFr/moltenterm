// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The collapsed rail's mark (FR-SHELL-079, #2384): with the sidebar hidden, what is left at the window's left edge is the
// current project's mark with the header's own liseré, so the developer still tells which project and workspace the
// window is on. Kept apart from the component so the rules can be tested without the app.

import type { HeaderMark } from "./sidebar-header-model";
import { currentProject, headerProjectType, projectLabel } from "./workspace-projects";

// The rail's width, as sidebar.css's --mt-rail-px states it: the room left of the content while the sidebar is hidden.
// A test keeps the two equal.
export const CollapsedRailPx = 30;

// The mark's face: the project's logo, else the workspace's icon, else the first letter of the workspace's name.
export type MarkFace = { kind: "logo"; logo: string } | { kind: "workspace" } | { kind: "initial"; letter: string };

// The icon the expanded header shows beside the workspace's name is the mark. A header with none (one project without a
// logo) is stood for by the first letter of the workspace's name, or by the workspace's icon when the name has none.
export function markFace(header: HeaderMark, workspaceName: string): MarkFace {
    if (header.kind === "logo") {
        return { kind: "logo", logo: header.logo };
    }
    if (header.kind === "workspace") {
        return { kind: "workspace" };
    }
    const letter = Array.from(workspaceName?.trim() ?? "")[0];
    return letter == null ? { kind: "workspace" } : { kind: "initial", letter: letter.toLocaleUpperCase() };
}

// What a click on the mark opens, as the expanded header does: its project chip's menu when it shows one, else the
// workspace menu of its ⋯.
export type MarkAction = "project" | "workspace";

export function markAction(ws: { meta?: Record<string, any> }): MarkAction {
    return headerProjectType(ws) !== "" ? "project" : "workspace";
}

// What the mark's hover names: the workspace and, when it has one, its current project ("Acme · Desktop").
export function markProjectName(ws: { meta?: Record<string, any> }): string {
    return projectLabel(currentProject(ws));
}
