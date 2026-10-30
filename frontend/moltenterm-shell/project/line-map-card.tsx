// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project overview's map slot (FR-MC-020, FR-MC-022): the line map of the linked project, with its "Full size"
// that enlarges the map over the whole Project panel, in place (FR-SHELL-094).

import { getBlockMetaKeyAtom } from "@/app/store/global";
import { cn } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { LineMap } from "../mission/line-map";
import { ciRunningBranch } from "../mission/line-map-view";
import { ProjectBranchesMetaKey } from "../widget-options";
import { ProjectCardProps } from "./project-context";

const NoFilter = atom(null) as Atom<unknown>;

export function LineMapCard({ project, projectName, snapshot, ci, release, blockId, mapFull, toggleMapFull }: ProjectCardProps) {
    const branchFilter = useAtomValue(
        blockId ? getBlockMetaKeyAtom(blockId, ProjectBranchesMetaKey as keyof MetaType) : NoFilter
    );
    return (
        <div className={cn(mapFull && "flex h-full min-h-0 flex-col")} data-testid="project-linemap">
            <LineMap
                dir={project.dir}
                projectName={projectName}
                snapshot={snapshot}
                ciBranches={ci?.branches}
                ciRunning={ciRunningBranch(ci)}
                session={release}
                branchFilter={branchFilter}
                full={!!mapFull}
                onFullSize={toggleMapFull}
            />
        </div>
    );
}
