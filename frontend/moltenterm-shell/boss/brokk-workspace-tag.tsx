// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace of a row in Brokk's panels (FR-BOSS-009, AC19, #2032): Brokk is not scoped to a workspace, so every row
// names its own, with a coloured dot, and leads to it. The label is the notification centre's (notification-workspace.ts).

import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useT } from "../i18n/i18n";
import { WorkspaceLabel, workspaceLabel, workspaceLabelText } from "../notification-workspace";
import { showProjectTab } from "../project/project-tab";
import { readWorkspaceProject } from "../workspace-project";

// The workspace a project folder belongs to: the one whose project it is. A pull request names a folder, not a workspace.
export function workspaceIdForDir(workspaces: Map<string, Workspace>, dir: string): string {
    if (!dir) {
        return "";
    }
    const wanted = dir.replace(/[/\\]+$/, "");
    for (const [id, workspace] of workspaces ?? []) {
        if (readWorkspaceProject(workspace).dir.replace(/[/\\]+$/, "") === wanted) {
            return id;
        }
    }
    return "";
}

export function labelOfRow(
    workspaces: Map<string, Workspace>,
    currentId: string,
    row: { workspaceid?: string; dir?: string },
    tabId?: string
): WorkspaceLabel {
    const id = row.workspaceid || workspaceIdForDir(workspaces, row.dir ?? "");
    return workspaceLabel(id, workspaces, currentId, tabId);
}

// Leads to the workspace: another one is switched to, the current one shows its project tab.
export function goToWorkspace(label: WorkspaceLabel): void {
    if (label == null || label.missing) {
        return;
    }
    if (!label.current) {
        getApi().switchWorkspace(label.id);
        return;
    }
    fireAndForget(() => showProjectTab(label.id));
}

export function WorkspaceTag({ label, onGo }: { label: WorkspaceLabel; onGo?: () => void }) {
    const t = useT();
    if (label == null) {
        return null;
    }
    const text = workspaceLabelText(label);
    const content = (
        <>
            <i
                aria-hidden
                data-testid="workspace-dot"
                className="mt-brokk-ws-dot"
                style={{ background: label.color || "var(--mt-text-3)" }}
            />
            <span className="min-w-0 truncate" data-testid="workspace-name">
                {label.name}
            </span>
        </>
    );
    if (label.missing) {
        return (
            <span className="mt-brokk-ws" data-testid="workspace-chip" title={text}>
                {content}
            </span>
        );
    }
    return (
        <button
            type="button"
            title={label.current ? text : t("notif.workspace.goTo", { name: text })}
            aria-label={t(label.current ? "notif.workspace.label" : "notif.workspace.goToLabel", { name: text })}
            data-testid="workspace-chip"
            data-current={label.current ? "true" : undefined}
            onClick={(e) => {
                e.stopPropagation();
                (onGo ?? (() => goToWorkspace(label)))();
            }}
            className={cn("mt-brokk-ws cursor-pointer hover:text-primary")}
        >
            {content}
        </button>
    );
}
