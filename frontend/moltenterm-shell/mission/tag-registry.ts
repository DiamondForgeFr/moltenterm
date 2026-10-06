// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The CI/CD workshop's full tag registry (FR-MC-025, absorbing FR-MC-004's version catalogue): every version the
// project has, planned (an open milestone named after a version not tagged yet), in release candidate or published,
// with its notes and the local builds made from it. Read from what the collector already returns: no new git or
// GitHub call. Kept apart from the components so the rules can be tested without the app.

import { DefaultTagPrefix } from "../releases/versions";
import { milestoneKey } from "./github";
import { MissionGit, MissionGithub, RunRecord } from "./mission-model";
import { isPrereleaseTag, tagVersion } from "./versions";

const PlainVersion = /^\d+\.\d+\.\d+$/;

export type RegistryKind = "planned" | "rc" | "public";

export type RegistryRow = {
    kind: RegistryKind;
    // The tag; for a planned version, the tag it will get.
    tag: string;
    // The version without the release candidate's suffix (1.2.0 for v1.2.0-3).
    version: string;
    // The tag's date, the GitHub release's when git lacks the tag, the milestone's due date (may be empty).
    date: string;
    sha?: string;
    notes?: string;
    github?: { draft: boolean; latest: boolean; name: string };
    milestone?: { title: string; url: string; open: number; closed: number };
    // The local builds made from the tag's commit, newest first.
    builds: string[];
};

function baseVersion(tag: string, prefix: string): string {
    return tagVersion(tag, prefix).replace(/-.*$/, "");
}

function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) {
            return pa[i] - pb[i];
        }
    }
    return 0;
}

// 1.1.0 > 1.1.0-2 > 1.1.0-1 > 1.0.0; tags outside X.Y.Z[-N] compare as 0.0.0.
function compareTags(a: string, b: string, prefix: string): number {
    const core = (tag: string) => {
        const v = baseVersion(tag, prefix);
        return PlainVersion.test(v) ? v : "0.0.0";
    };
    const byCore = compareVersions(core(a), core(b));
    if (byCore !== 0) {
        return byCore;
    }
    const rc = (tag: string) => {
        const m = /-(\d+)$/.exec(tagVersion(tag, prefix));
        return m ? Number(m[1]) : Infinity;
    };
    const ra = rc(a);
    const rb = rc(b);
    return ra === rb ? 0 : ra < rb ? -1 : 1;
}

// The notes without their title line: the row already names the tag.
function notesBody(notes: string): string {
    const body = (notes ?? "")
        .trim()
        .replace(/^#[^\n]*\n+/, "")
        .trim();
    return body || undefined;
}

function buildsFrom(runs: RunRecord[], sha: string): string[] {
    if (!sha) {
        return [];
    }
    const titles = (runs ?? [])
        .filter((r) => r.kind === "build" && r.state === "success" && r.commit === sha)
        .map((r) => r.title || r.stepid);
    return [...new Set(titles)];
}

// Planned versions first (highest first), then the tags newest first.
export function tagRegistry(git: MissionGit, github: MissionGithub, runs: RunRecord[]): RegistryRow[] {
    const prefix = git?.tagprefix || DefaultTagPrefix;
    const releases = new Map((github?.releases ?? []).map((r) => [r.tagName, r]));
    const rows: RegistryRow[] = (git?.tags ?? []).map((t) => {
        const release = releases.get(t.name);
        releases.delete(t.name);
        return {
            kind: isPrereleaseTag(t.name, prefix) ? "rc" : "public",
            tag: t.name,
            version: baseVersion(t.name, prefix),
            date: t.date,
            sha: t.sha,
            notes: notesBody(t.notes),
            github: release ? { draft: release.isDraft, latest: release.isLatest, name: release.name } : undefined,
            builds: buildsFrom(runs, t.sha),
        };
    });
    for (const release of releases.values()) {
        rows.push({
            kind: release.isPrerelease || isPrereleaseTag(release.tagName, prefix) ? "rc" : "public",
            tag: release.tagName,
            version: baseVersion(release.tagName, prefix),
            date: release.publishedAt || release.createdAt,
            github: { draft: release.isDraft, latest: release.isLatest, name: release.name },
            builds: [],
        });
    }
    // Tags made in the same second (a scripted cut) fall back to the version order.
    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime() || compareTags(b.tag, a.tag, prefix));
    const tagged = new Set(rows.map((r) => r.version));
    const planned: RegistryRow[] = [];
    for (const m of github?.milestones ?? []) {
        const version = milestoneKey(m?.title);
        if (!PlainVersion.test(version) || tagged.has(version)) {
            continue;
        }
        tagged.add(version);
        planned.push({
            kind: "planned",
            tag: prefix + version,
            version,
            date: m.due_on ?? "",
            milestone: { title: m.title, url: m.html_url, open: m.open_issues ?? 0, closed: m.closed_issues ?? 0 },
            builds: [],
        });
    }
    planned.sort((a, b) => compareVersions(b.version, a.version));
    return [...planned, ...rows];
}
