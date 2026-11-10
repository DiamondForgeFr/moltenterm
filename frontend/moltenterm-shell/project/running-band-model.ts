// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which runs the Project overview's "In progress" band lists besides the local build and the release followed
// (FR-MC-024, #2188): the rest of what the Now card used to list.

import { CiState } from "../mission/ci-model";
import { RunRecord } from "../mission/mission-model";
import { ReleaseSession } from "../mission/release-model";
import { BandRow } from "../mission/run-row-model";
import { projectWork, WorkItem } from "./project-model";

export function workBandRow(item: WorkItem): BandRow {
    return {
        id: item.id,
        kind: "work",
        tone: "working",
        name: item.label,
        context: item.detail,
        note: "",
        phases: [],
        startedat: item.startedat,
        endedat: 0,
        estimateMs: 0,
    };
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
