// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which runs the Project overview's "In progress" band lists (FR-MC-024, #2188). The band's own code loads only when
// something runs (running-band.tsx): what decides that stays small, here, with the code the cards always need.

import { CiState } from "../mission/ci-model";
import { RunRecord } from "../mission/mission-model";
import { ReleaseSession } from "../mission/release-model";
import { projectWork, WorkItem } from "./project-model";

// A build is in the band while it runs and, once it failed or was interrupted, until the developer closes it; one that
// succeeded or was cancelled is a line of the Now card (#2188).
export function buildInBand(run: RunRecord): boolean {
    if (run == null) {
        return false;
    }
    return run.state === "running" || (!run.closed && (run.state === "failure" || run.state === "lost"));
}

// What runs besides the local build and the release followed in the band, and besides the trunk's CI, which keeps its
// line in Now.
export function bandWork(
    ci: CiState,
    runs: readonly RunRecord[],
    release: ReleaseSession,
    opts: { pipelined: boolean; trunk: string }
): WorkItem[] {
    const ciRun = ci?.running ? (ci.runs ?? []).find((r) => r.id === ci.running) : null;
    const ciOnTrunk = ciRun != null && ciRun.branch === opts.trunk;
    return projectWork(ci, runs, release).filter(
        (item) =>
            item.kind !== "build" && !(opts.pipelined && item.kind === "release") && !(ciOnTrunk && item.kind === "ci")
    );
}
