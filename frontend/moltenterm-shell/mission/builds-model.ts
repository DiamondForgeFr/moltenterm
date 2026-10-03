// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the Build local menu says (FR-MC-012): mirrors BuildsFacts in pkg/molten/mission/builds.go. Kept apart from the
// components so the wording can be tested without the app.

import { CiVerdictStatus } from "./ci-model";

export type BuildManifest = {
    productName?: string;
    version?: string;
    buildId?: number;
    builtAt?: string;
    commit: string;
    app?: string;
    notes?: any[];
};

export type BuildFacts = {
    id: string;
    title?: string;
    description?: string;
    kind?: string;
    verify?: string;
    artifact?: string;
    manifest?: string;
    last?: BuildManifest;
};

export type BuildsFacts = {
    trunk?: string;
    trunksha?: string;
    ci?: { status: CiVerdictStatus; failed?: string[]; missing?: string[]; sha: string };
    fetcherror?: string;
    builds: BuildFacts[];
};

export function relativeAge(iso: string, now: number): string {
    const then = Date.parse(iso);
    if (!(then > 0)) {
        return "";
    }
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    const minutes = Math.round((then - now) / 60_000);
    if (Math.abs(minutes) < 60) {
        return rtf.format(minutes, "minute");
    }
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 48) {
        return rtf.format(hours, "hour");
    }
    return rtf.format(Math.round(hours / 24), "day");
}

export function lastBuildLine(last: BuildManifest, now: number): string {
    if (last == null) {
        return "Never built";
    }
    const age = last.builtAt ? relativeAge(last.builtAt, now) : "";
    return `Last: ${age ? `${age} · ` : ""}${last.commit.slice(0, 7)}`;
}

// What the CI says about the trunk, for a build the CI gates. A red job runs again before the build, which stops only
// if it fails again.
export function ciLine(facts: BuildsFacts): string {
    const trunk = facts?.trunk || "the trunk";
    switch (facts?.ci?.status) {
        case "success":
            return `CI green on ${trunk}.`;
        case "failure":
            return `CI red on ${trunk} (${(facts.ci.failed ?? []).join(", ")}): it runs again first, and the build stops if it fails.`;
        case "running":
            return `The local CI is running on ${trunk}.`;
    }
    return `The local CI will run first on ${trunk}.`;
}

export function buildCardTitle(projectName: string, build: Pick<BuildFacts, "id" | "title">): string {
    const title = build.title || build.id;
    return title.toLowerCase().startsWith(projectName.toLowerCase()) ? title : `${projectName} ${title}`;
}

// The local build panel (FR-MC-013): what a build run shows, derived from its record, the phases its build declares
// and the manifest delivered.

export type BuildPhaseDef = { id: string; title?: string; text?: string };
export type BuildPhaseStatus = "todo" | "running" | "done" | "failed";

export type BuildRunInput = {
    state: "running" | "success" | "failure" | "cancelled" | "lost";
    phases: string[];
    startedat: number;
    commit?: string;
};

export type BuildRunView = {
    phases: { id: string; title: string; status: BuildPhaseStatus }[];
    line: string;
    delivered: BuildManifest;
    showLog: boolean;
};

function phaseTitle(phase: BuildPhaseDef): string {
    return phase.title || phase.id.charAt(0).toUpperCase() + phase.id.slice(1);
}

// The delivered build is this run's when its manifest names the run's commit and was written after it started.
export function deliveredBy(run: BuildRunInput, manifest: BuildManifest): BuildManifest {
    if (run.state !== "success" || manifest == null || !run.commit || manifest.commit !== run.commit) {
        return null;
    }
    const builtAt = Date.parse(manifest.builtAt ?? "");
    return builtAt >= run.startedat - 60_000 ? manifest : null;
}

export function buildRunView(run: BuildRunInput, declared: BuildPhaseDef[], manifest: BuildManifest): BuildRunView {
    const defs: BuildPhaseDef[] = declared?.length ? declared : [...new Set(run.phases)].map((id) => ({ id }));
    const ids = defs.map((d) => d.id);
    const seen = run.phases.filter((p) => ids.includes(p));
    const current = seen.length ? ids.indexOf(seen[seen.length - 1]) : 0;
    const done = run.state === "success";
    const phases = defs.map((def, i) => {
        let status: BuildPhaseStatus = "todo";
        if (done || i < current) {
            status = "done";
        } else if (i === current) {
            status = run.state === "running" ? "running" : "failed";
        }
        return { id: def.id, title: phaseTitle(def), status };
    });
    const at = defs[current] ? phaseTitle(defs[current]) : "the build";
    const delivered = deliveredBy(run, manifest);
    let line = defs[current]?.text ?? "";
    if (done) {
        line = delivered
            ? `Delivered: ${delivered.productName ?? ""} ${delivered.version ?? ""}, commit ${delivered.commit.slice(0, 7)}, ${(delivered.notes ?? []).length} commit(s) since the previous one.`.replace(
                  /\s+/g,
                  " "
              )
            : "Built.";
    } else if (run.state === "failure") {
        line = `Failed during “${at}”. The end of the log says why.`;
    } else if (run.state === "lost") {
        line = `Interrupted during “${at}”: its process is gone without an exit code.`;
    } else if (run.state === "cancelled") {
        line = `Cancelled during “${at}”.`;
    }
    return { phases, line, delivered, showLog: !done };
}
