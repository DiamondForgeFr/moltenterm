// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a row of the Project overview's "In progress" band shows (FR-MC-024, #2188): the phases a run is made of, where
// it stands, and how long it has been going. Computed from the run's record (the local build) or the release's facts, so
// the rules can be tested without the app.

import { t } from "../i18n/i18n";
import { BuildManifest, BuildPhaseDef, buildRunView } from "./builds-model";
import { RunRecord } from "./mission-model";
import { PhaseStatus, ReleaseGhJob, ReleaseRun } from "./release-run";

// The heat scale's states a run can be in: running (working), waiting for the developer, failed. A run that succeeded
// leaves the band.
export type RowTone = "working" | "waiting" | "failed";

export type RowPhase = {
    id: string;
    label: string;
    status: PhaseStatus;
    // How much of the phase's segment is filled, 0 to 1.
    fill: number;
    // The current phase is named with its progress under the bar.
    current: boolean;
    // "62 %", "12/15", "your turn": empty when the phase has none to say.
    progress: string;
    // The phase's state in words, for assistive technologies (the colour is never alone).
    says: string;
};

export type BandRowKind = "build" | "release" | "work";

export type BandRow = {
    id: string;
    kind: BandRowKind;
    tone: RowTone;
    name: string;
    context: string;
    // What the current phase does as the project declares it, or why the run stopped when it did.
    note: string;
    phases: RowPhase[];
    startedat: number;
    // When a run that stopped did, so its time stands still; 0 while it goes on.
    endedat: number;
    // What the same build took last time, 0 when there is no earlier one to measure against.
    estimateMs: number;
};

const PhaseWords: Record<PhaseStatus, string> = {
    todo: "mc.releaseRun.says.todo",
    running: "mc.releaseRun.says.running",
    waiting: "mc.releaseRun.says.waiting",
    done: "mc.releaseRun.says.done",
    failed: "mc.releaseRun.says.failed",
};

export function saysOf(status: PhaseStatus): string {
    return t(PhaseWords[status]);
}

// The previous successful run of the same step, which the running one is measured against. The list is newest first.
export function previousSuccess(runs: readonly RunRecord[], run: RunRecord): RunRecord {
    return (
        (runs ?? []).find(
            (r) =>
                r.id !== run.id &&
                r.kind === run.kind &&
                r.stepid === run.stepid &&
                r.state === "success" &&
                (r.finishedat ?? 0) > r.startedat
        ) ?? null
    );
}

// What the previous successful run of the same step took.
export function estimateMs(runs: readonly RunRecord[], run: RunRecord): number {
    const earlier = previousSuccess(runs, run);
    return earlier ? earlier.finishedat - earlier.startedat : 0;
}

// How long each phase of a finished run took, from when its marker was first seen to when the next one was, or the run
// ended. A run written before the markers were stamped has none.
export function phaseDurations(run: RunRecord): Record<string, number> {
    const rtn: Record<string, number> = {};
    const at = run?.phaseat ?? [];
    (run?.phases ?? []).forEach((id, i) => {
        const end = at[i + 1] ?? run.finishedat;
        if (id in rtn || at[i] == null || end == null || end < at[i]) {
            return;
        }
        rtn[id] = end - at[i];
    });
    return rtn;
}

// How far into the phase it is, from how long the same phase took in the build before: an estimate, so it never reaches
// 0 or 100 while the phase runs. null when the build before has no such phase, or the marker was not stamped.
export function phaseShare(run: RunRecord, previous: RunRecord, phaseId: string, now: number): number {
    const index = (run.phases ?? []).lastIndexOf(phaseId);
    const start = index < 0 ? null : (run.phaseat ?? [])[index];
    const took = previous ? phaseDurations(previous)[phaseId] : 0;
    if (start == null || !(took > 0)) {
        return null;
    }
    return Math.min(Math.max((now - start) / took, 0.02), 0.98);
}

const IndeterminateFill = 0.4;

export function buildContext(trunk: string, commit: string): string {
    if (!trunk) {
        return t("project.band.buildLocal");
    }
    return commit
        ? t("project.band.buildFrom", { branch: trunk, sha: commit.slice(0, 7) })
        : t("project.band.buildOn", { branch: trunk });
}

export function buildBandRow(
    run: RunRecord,
    defs: BuildPhaseDef[],
    manifest: BuildManifest,
    runs: readonly RunRecord[],
    trunk: string,
    now: number
): BandRow {
    const view = buildRunView(run, defs, manifest);
    const previous = run.state === "running" ? previousSuccess(runs, run) : null;
    const estimate = previous ? previous.finishedat - previous.startedat : 0;
    const phases = view.phases.map((p): RowPhase => {
        const current = p.status === "running" || p.status === "failed";
        let fill = p.status === "done" || p.status === "failed" ? 1 : 0;
        let progress = "";
        if (p.status === "running") {
            const share = phaseShare(run, previous, p.id, now);
            fill = share ?? IndeterminateFill;
            progress = share == null ? "" : t("project.band.percent", { percent: Math.round(share * 100) });
        }
        return { id: p.id, label: p.title, status: p.status, fill, current, progress, says: saysOf(p.status) };
    });
    const stopped = run.state !== "running";
    return {
        id: `build:${run.id}`,
        kind: "build",
        tone: stopped ? "failed" : "working",
        name: run.title || run.stepid,
        context: buildContext(trunk, run.commit),
        note: view.line,
        phases,
        startedat: run.startedat,
        endedat: stopped ? (run.finishedat ?? 0) : 0,
        estimateMs: estimate,
    };
}

function jobsDone(jobs: readonly ReleaseGhJob[]): { done: number; total: number } {
    const list = jobs ?? [];
    return { done: list.filter((j) => j.status === "completed").length, total: list.length };
}

export function releaseContext(run: ReleaseRun): string {
    const channel = run.channel === "rc" ? t("project.band.releaseCandidate") : t("project.band.releasePublic");
    const cut = run.phases.find((p) => p.id === "cut");
    return cut?.status === "done" ? t("project.band.releaseTagged", { channel }) : channel;
}

export function releaseBandRow(run: ReleaseRun, jobs: readonly ReleaseGhJob[], startedat: number): BandRow {
    const { done, total } = jobsDone(jobs);
    const phases = run.phases.map((p): RowPhase => {
        const current = p.id === run.current;
        let fill = p.status === "todo" ? 0 : 1;
        let progress = "";
        if (p.status === "running") {
            const counted = p.id === "build" && total > 0;
            fill = counted ? Math.min(Math.max(done / total, 0.04), 0.96) : IndeterminateFill;
            progress = counted ? `${done}/${total}` : "";
        } else if (current && (p.status === "waiting" || p.status === "failed")) {
            progress = saysOf(p.status);
        }
        return {
            id: p.id,
            label: t(`mc.releaseRun.short.${p.id}`),
            status: p.status,
            fill,
            current,
            progress,
            says: saysOf(p.status),
        };
    });
    const failed = phases.some((p) => p.status === "failed");
    const waiting = phases.find((p) => p.current)?.status === "waiting";
    return {
        id: `release:${run.tag}`,
        kind: "release",
        tone: failed ? "failed" : waiting ? "waiting" : "working",
        name: t("project.band.release", { tag: run.tag }),
        context: releaseContext(run),
        note: "",
        phases,
        startedat,
        endedat: 0,
        estimateMs: 0,
    };
}

// Any other run the overview lists: its name, its detail and its start, with no phases.
export function workBandRow(item: { id: string; label: string; detail: string; startedat: number }): BandRow {
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

// "3 min 12", "18 min", "45 s": the time of a run, for a row.
export function durationText(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) {
        return t("project.band.duration.seconds", { seconds });
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 10) {
        return t("project.band.duration.minutesSeconds", { minutes, seconds: String(seconds % 60).padStart(2, "0") });
    }
    if (minutes < 60) {
        return t("project.band.duration.minutes", { minutes });
    }
    return t("project.band.duration.hoursMinutes", {
        hours: Math.floor(minutes / 60),
        minutes: String(minutes % 60).padStart(2, "0"),
    });
}
