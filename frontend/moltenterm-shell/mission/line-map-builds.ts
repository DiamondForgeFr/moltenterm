// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the local builds sit on the line map (FR-MC-022, #288): the most recent delivered build of each flavor, at the
// commit it was made from. Placed with the history the map already holds, no new git call; a pure function, tested
// without the app.

import { BuildFacts, BuildManifest } from "./builds-model";
import type { LineMapStation } from "./line-map-model";
import { RawCommit } from "./mission-model";

// How far the build's commit stands from the window and the lines: on develop or on main inside the window, before
// it (the chip at the left edge), older than the history the collector read, or not in that history at all.
export type BuildPlace = "develop" | "main" | "before" | "beyond" | "unknown";

export type LocalBuild = {
    id: string;
    kind?: string;
    title?: string;
    artifact?: string;
    manifest: BuildManifest;
};

export type BuildMarker = {
    key: string;
    flavor: string;
    label: string;
    place: BuildPlace;
    build: LocalBuild;
    commit: string;
    subject: string;
    // The commit's own time; NaN when the commit was not found.
    at: number;
    // The tag whose commit the build was made from, when it was cut from a tag.
    tag: string;
    // Commits on the trunk since the build's commit; null when the history read does not tell.
    behind: number;
    // The count is a floor: the build is older than the history read.
    behindCapped: boolean;
};

const FlavorLabels: Record<string, string> = { gold: "Gold", rc: "RC local" };

export function flavorOf(build: Pick<LocalBuild, "id" | "kind">): string {
    return build.kind || build.id;
}

export function flavorLabel(build: Pick<LocalBuild, "id" | "kind" | "title">): string {
    const flavor = flavorOf(build);
    return FlavorLabels[flavor] ?? (build.title || flavor);
}

function builtAt(build: LocalBuild): number {
    const t = Date.parse(build.manifest?.builtAt ?? "");
    return Number.isFinite(t) ? t : 0;
}

// What the builds' manifests deliver, as the line map's input: the builds that left one.
export function localBuildsOf(facts: readonly BuildFacts[]): LocalBuild[] {
    return (facts ?? [])
        .filter((b) => b.last?.commit)
        .map((b) => ({ id: b.id, kind: b.kind, title: b.title, artifact: b.artifact, manifest: b.last }));
}

// The most recent build of each flavor only (the order of the builds kept).
export function latestBuildPerFlavor(builds: readonly LocalBuild[]): LocalBuild[] {
    const latest = new Map<string, LocalBuild>();
    for (const b of builds ?? []) {
        if (!b?.manifest?.commit) {
            continue;
        }
        const flavor = flavorOf(b);
        const held = latest.get(flavor);
        if (held == null || builtAt(b) > builtAt(held)) {
            latest.set(flavor, b);
        }
    }
    return [...latest.values()];
}

function sameCommit(a: string, b: string): boolean {
    return a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
}

function findCommit(list: readonly RawCommit[], sha: string): number {
    return list.findIndex((c) => sameCommit(c.sha, sha));
}

function time(iso: string): number {
    const t = new Date(iso ?? "").getTime();
    return Number.isFinite(t) ? t : NaN;
}

function isMerge(c: RawCommit): boolean {
    return (c.parents?.length ?? 1) > 1;
}

export type PlaceBuildsInput = {
    // develop's commits as the collector read them, newest first.
    trunk: readonly RawCommit[];
    // main's, newest first; empty in a single-branch project.
    release: readonly RawCommit[];
    stations: readonly LineMapStation[];
    // The develop commit a main commit was made from (makeSourceFinder in line-map-model.ts).
    findSource: (commit: { sha: string; at: number }) => RawCommit;
    start: number;
    // The collector stops at this many trunk commits.
    trunkRead: number;
};

export function placeBuildMarkers(builds: readonly LocalBuild[], input: PlaceBuildsInput): BuildMarker[] {
    const { trunk, release, stations, start, findSource } = input;
    const since = (c: RawCommit) =>
        c == null ? null : trunk.slice(0, trunk.indexOf(c)).filter((t) => !isMerge(t)).length;
    return latestBuildPerFlavor(builds).map((build): BuildMarker => {
        const commit = build.manifest.commit;
        const marker: BuildMarker = {
            key: `build:${flavorOf(build)}`,
            flavor: flavorOf(build),
            label: flavorLabel(build),
            place: "unknown",
            build,
            commit,
            subject: "",
            at: NaN,
            tag: null,
            behind: null,
            behindCapped: false,
        };
        const onTrunk = trunk[findCommit(trunk, commit)];
        if (onTrunk) {
            const at = time(onTrunk.date);
            return {
                ...marker,
                place: at >= start ? "develop" : "before",
                subject: onTrunk.subject,
                at,
                behind: since(onTrunk),
            };
        }
        const onRelease = release[findCommit(release, commit)];
        const tag = stations.find((s) => sameCommit(s.sha, commit));
        if (onRelease || tag) {
            const at = onRelease ? time(onRelease.date) : tag.at;
            const source = findSource({ sha: onRelease?.sha ?? tag.sha, at });
            return {
                ...marker,
                place: at >= start ? "main" : "before",
                subject: onRelease?.subject ?? tag.source?.subject ?? "",
                at,
                tag: tag?.name ?? null,
                behind: since(source),
            };
        }
        // Older than the history read: only a floor of the commits since is known.
        if (trunk.length >= input.trunkRead) {
            return { ...marker, place: "beyond", behind: trunk.filter((t) => !isMerge(t)).length, behindCapped: true };
        }
        return marker;
    });
}
