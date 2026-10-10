// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map full size (FR-MC-022): the same map as the Project overview's, in its own block, over a wider window
// (60 days unless the user chose another) and with room per day, scrolling sideways when it runs past the pane.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { atom } from "jotai";
import { CiState } from "./ci-model";
import { LineMap } from "./line-map";
import { MoltentermLineMapView } from "./line-map-model";
import { useCiState, useReleaseSession } from "./mission-client";
import { ActiveProject, MissionFrame, MissionHeader } from "./mission-frame";
import { MissionSnapshot } from "./mission-model";

export { MoltentermLineMapView };

export class LineMapViewModel implements ViewModel {
    viewType = MoltentermLineMapView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("timeline");
    viewName = atom("Line map");
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return LineMapFullView;
    }
}

// The branch the local CI runs on, if a run is under way.
export function ciRunningBranch(ci: CiState): string {
    if (!ci?.running) {
        return null;
    }
    return (ci.runs ?? []).find((r) => r.id === ci.running)?.branch || null;
}

function LineMapFullView() {
    return (
        <MissionFrame title="The line map">
            {({ project, snapshot, refresh }) => (
                <LineMapFullContent key={project.dir} project={project} snapshot={snapshot} refresh={refresh} />
            )}
        </MissionFrame>
    );
}

function LineMapFullContent({
    project,
    snapshot,
    refresh,
}: {
    project: ActiveProject;
    snapshot: MissionSnapshot;
    refresh: () => void;
}) {
    const { state: ci } = useCiState(project.dir);
    const { session } = useReleaseSession(project.dir);
    return (
        <>
            <MissionHeader project={project} snapshot={snapshot} onRefresh={refresh} />
            <div className="flex min-h-0 flex-1 flex-col p-3" data-testid="line-map-full">
                <LineMap
                    dir={project.dir}
                    snapshot={snapshot}
                    ciBranches={ci?.branches}
                    ciRunning={ciRunningBranch(ci)}
                    session={session}
                    full={true}
                />
            </div>
        </>
    );
}
