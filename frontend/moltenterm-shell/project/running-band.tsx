// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The "In progress" band (FR-MC-024, #2188): what runs, in one band across the full width above the cards, and nothing
// when nothing runs. Its rows (running-band-view.tsx) are code the Project view needs only while a build, a release or
// another run goes on, so they load then, not with the window: this card only decides whether the band is there.

import { lazy, Suspense, useMemo } from "react";
import { latestRun } from "../mission/mission-model";
import { ProjectCardProps } from "./project-context";
import { bandWork, buildInBand } from "./running-band-model";

const RunningBandView = lazy(() => import("./running-band-view").then((m) => ({ default: m.RunningBandView })));

export function RunningBand(props: ProjectCardProps) {
    const { pipeline, runs, ci, release, snapshot, releaseFollow } = props;
    const trunk = snapshot?.git?.trunk ?? "";
    const work = useMemo(
        () => bandWork(ci, runs, release, { pipelined: pipeline != null, trunk }),
        [ci, runs, release, pipeline, trunk]
    );
    if (!buildInBand(latestRun(runs, "build")) && releaseFollow?.run == null && work.length === 0) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <RunningBandView {...props} />
        </Suspense>
    );
}
