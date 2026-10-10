// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project overview's map slot (FR-MC-020, FR-MC-022): the line map of the linked project, with its "Full size"
// that opens the same map in its own block.

import { getBlockMetaKeyAtom } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { LineMap } from "../mission/line-map";
import { ciRunningBranch, MoltentermLineMapView } from "../mission/line-map-view";
import { openMoltentermView } from "../open-view";
import { ProjectBranchesMetaKey } from "../widget-options";
import { ProjectCardProps } from "./project-context";

const NoFilter = atom(null) as Atom<unknown>;

export function LineMapCard({ project, snapshot, ci, release, blockId }: ProjectCardProps) {
    const branchFilter = useAtomValue(
        blockId ? getBlockMetaKeyAtom(blockId, ProjectBranchesMetaKey as keyof MetaType) : NoFilter
    );
    return (
        <div data-testid="project-linemap">
            <LineMap
                dir={project.dir}
                snapshot={snapshot}
                ciBranches={ci?.branches}
                ciRunning={ciRunningBranch(ci)}
                session={release}
                branchFilter={branchFilter}
                onFullSize={() => fireAndForget(() => openMoltentermView(MoltentermLineMapView))}
            />
        </div>
    );
}
