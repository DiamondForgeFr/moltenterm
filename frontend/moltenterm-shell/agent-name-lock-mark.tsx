// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The small lock beside a first name that is locked for a project (FR-CONT-014, #2324): on the agent's header title and
// in the agents lists. Its tooltip says for which project.

import { atoms } from "@/app/store/global";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { lockProjectLabel } from "./agent-name-locks-model";
import { useT } from "./i18n/i18n";
import { readProjects } from "./sidebar/workspace-projects";

// What the project is called here: the window's workspace names its own projects, any other folder is its folder's name.
export function useLockProjectLabel(folder: string): string {
    const ws = useAtomValue(atoms.workspace);
    return lockProjectLabel(folder, readProjects(ws));
}

export function AgentNameLockMark({ name, folder, className }: { name: string; folder: string; className?: string }) {
    const t = useT();
    const project = useLockProjectLabel(folder);
    const title = t("agentNames.markTitleNamed", { name, project });
    return (
        <i
            role="img"
            className={cn(makeIconClass("lock", false), "shrink-0 text-11 text-secondary", className)}
            title={title}
            aria-label={title}
            data-testid="agent-name-lock"
        />
    );
}
