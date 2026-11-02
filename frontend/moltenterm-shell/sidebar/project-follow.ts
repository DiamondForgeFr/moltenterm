// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Showing a view or an agent of another project makes its project current (FR-SHELL-087, #1760): the header's logo
// changes and a short toast names the project, so the change is never silent. A switch the developer made from the
// project menu or a chip already says so.

import { useEffect, useRef } from "react";
import { t } from "../i18n/i18n";
import { showToast } from "../toast-store";
import { projectLabel, readProjects } from "./workspace-projects";
import { lastExplicitSwitchAt } from "./workspace-projects-store";

// How long after the developer's own switch a change of project is still that switch.
export const ExplicitSwitchWindowMs = 4000;

export function announcesImplicitSwitch(
    previousId: string,
    currentId: string,
    explicitAt: number,
    now: number
): boolean {
    if (!previousId || !currentId || previousId === currentId) {
        return false;
    }
    return now - explicitAt > ExplicitSwitchWindowMs;
}

const FollowToastId = "workspace-project-follow";

export function useProjectFollowToast(ws: Workspace, currentId: string) {
    const previous = useRef({ workspaceId: ws?.oid, projectId: currentId });
    useEffect(() => {
        const last = previous.current;
        previous.current = { workspaceId: ws?.oid, projectId: currentId };
        if (last.workspaceId !== ws?.oid) {
            return;
        }
        if (!announcesImplicitSwitch(last.projectId, currentId, lastExplicitSwitchAt(), Date.now())) {
            return;
        }
        const project = readProjects(ws).find((p) => p.id === currentId);
        if (project == null) {
            return;
        }
        showToast({
            id: FollowToastId,
            kind: "info",
            title: t("sidebar.project.followed", { project: projectLabel(project) }),
        });
    }, [currentId, ws?.oid]);
}
