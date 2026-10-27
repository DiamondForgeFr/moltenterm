// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The project chips (FR-SHELL-087): Pilotage's filter and the Project panel's switch draw the same chip.

import { cn, fireAndForget } from "@/util/util";
import { useT } from "../i18n/i18n";
import { workspaceShownName } from "../workspace-default-name";
import { currentProjectId, projectChipLabel, projectLabel, readProjects } from "./workspace-projects";
import { switchWorkspaceProject } from "./workspace-projects-store";

export function ProjectChip({
    on,
    label,
    title,
    testId,
    onClick,
}: {
    on: boolean;
    label: string;
    title?: string;
    testId?: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={on}
            title={title}
            className={cn(
                "h-6 max-w-full shrink-0 cursor-pointer truncate rounded-full border-0 px-2.5 text-11 whitespace-nowrap transition-colors duration-120 ease-mt",
                on ? "bg-accent/35 text-primary" : "bg-white/[0.07] text-secondary hover:bg-white/[0.13]"
            )}
            data-testid={testId}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

// The Project panel's chips ("Desktop · main"): a click makes that project the current one, which the panel follows.
export function ProjectSwitchChips({ workspace }: { workspace: Workspace }) {
    const t = useT();
    const projects = readProjects(workspace);
    if (projects.length < 2) {
        return null;
    }
    const current = currentProjectId(workspace);
    const name = workspaceShownName(workspace?.name, t);
    return (
        <div
            role="radiogroup"
            aria-label={t("sidebar.project.menuTitle", { name })}
            className="flex shrink-0 flex-wrap gap-1.5 border-b border-border px-3 py-2"
            data-testid="project-switch-chips"
        >
            {projects.map((p) => (
                <ProjectChip
                    key={p.id}
                    on={p.id === current}
                    label={projectChipLabel(p)}
                    title={
                        p.id === current
                            ? t("project.projects.currentTitle", { project: projectLabel(p) })
                            : t("project.projects.switchTitle", { project: projectLabel(p) })
                    }
                    testId={`project-switch-chip-${p.id}`}
                    onClick={() => {
                        if (p.id !== current) {
                            fireAndForget(() => switchWorkspaceProject(p.id));
                        }
                    }}
                />
            ))}
        </div>
    );
}
