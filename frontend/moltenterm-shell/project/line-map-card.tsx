// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project overview's map slot (FR-MC-020, FR-MC-022): the line map of the linked project, with its "Full size"
// that opens the same map in its own block.

import { fireAndForget } from "@/util/util";
import { LineMap } from "../mission/line-map";
import { ciRunningBranch, MoltentermLineMapView } from "../mission/line-map-view";
import { openMoltentermView } from "../open-view";
import { ProjectCardProps } from "./project-context";

export function LineMapCard({ project, snapshot, ci, release }: ProjectCardProps) {
    return (
        <div data-testid="project-linemap">
            <LineMap
                dir={project.dir}
                snapshot={snapshot}
                ciBranches={ci?.branches}
                ciRunning={ciRunningBranch(ci)}
                session={release}
                onFullSize={() => fireAndForget(() => openMoltentermView(MoltentermLineMapView))}
            />
        </div>
    );
}
