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
