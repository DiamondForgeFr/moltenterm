// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the group strip of the Project tab says (FR-MC-028, DS-MC-012): every member of the linked project's product, in
// rail order, with its state as the collector last read it, the stale flags and their Sync. It shows no other action:
// each member's Run CI, Build local, Release and Clean branches stay in its own workspace.

import { DependencyState, GroupMember, isFlaggedDependency, ProjectGroup } from "./group-model";

export type StripTone = "ok" | "bad" | "running" | "muted";

export type StripFact = { key: string; label: string; value: string; tone: StripTone; title?: string };

export type StripCommit = { sha: string; subject: string; tickets: string[] };

// The arguments of the notification's Sync action (dependency:sync in pkg/molten/mission/deps_notice.go), so the strip
// and the notification start the same thing.
export type SyncArgs = { dir: string; project: string; index: number };

export type StripDependency = {
    key: string;
    source: string;
    branch: string;
    // "stale", or "uncommitted": synced, not committed yet.
    state: DependencyState["state"];
    title: string;
    paths: string[];
    morePaths: number;
    commits: StripCommit[];
    moreCommits: number;
    // Some commits were left out by the collector itself (it keeps at most 50).
    moreCommitsCapped: boolean;
    uncommitted: string[];
    moreUncommitted: number;
    // Without a declared sync command the flag says so and offers no Sync (FR-MC-030-AC6).
    sync: SyncArgs;
};

export type StripMember = {
    member: GroupMember;
    current: boolean;
    // The workspace a click switches to: the first one linked to the member, in rail order. None for the current one.
    target: string;
    facts: StripFact[];
    // Said instead of the CI facts when the collector has nothing to tell yet.
    note: string;
    noteTone: StripTone;
    flagged: StripDependency[];
    // Declarations that could not be evaluated (source or branch not found, invalid, a git error): never a flag.
    unresolved: string[];
};

export const StripShownPaths = 3;
export const StripShownCommits = 5;
export const StripShownFiles = 3;

function sameDir(a: string, b: string): boolean {
    if (!a || !b) {
        return false;
    }
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

// The current member: the one linked to this workspace, else the one at the tab's folder.
export function isCurrentMember(member: GroupMember, workspaceId: string, dir: string): boolean {
    if (workspaceId && member.workspaces?.some((ws) => ws.id === workspaceId)) {
        return true;
    }
    return sameDir(member.dir, dir);
}

export function memberTarget(member: GroupMember, current: boolean): string {
    if (current) {
        return null;
    }
    return member.workspaces?.[0]?.id ?? null;
}

function localCiFact(trunkci: string, trunk: string): StripFact {
    const label = "Local CI";
    const title = `The local CI on the head of ${trunk}`;
    switch (trunkci) {
        case "success":
            return { key: "localci", label, value: "passed", tone: "ok", title };
        case "failure":
            return { key: "localci", label, value: "failed", tone: "bad", title };
        case "running":
            return { key: "localci", label, value: "running", tone: "running", title };
        case "missing":
            return { key: "localci", label, value: "no verdict", tone: "muted", title };
        default:
            return { key: "localci", label, value: "none", tone: "muted", title: "No local CI declared" };
    }
}

function remoteCiFact(remoteci: string, trunk: string): StripFact {
    const label = "GitHub CI";
    const title = `GitHub's runs on ${trunk}`;
    switch (remoteci) {
        case "success":
            return { key: "remoteci", label, value: "passed", tone: "ok", title };
        case "failure":
            return { key: "remoteci", label, value: "failed", tone: "bad", title };
        case "running":
            return { key: "remoteci", label, value: "running", tone: "running", title };
        default:
            return { key: "remoteci", label, value: "unknown", tone: "muted", title };
    }
}

const BuildTones: Record<string, StripTone> = {
    success: "ok",
    failure: "bad",
    lost: "bad",
    running: "running",
    cancelled: "muted",
};

const BuildWords: Record<string, string> = {
    success: "passed",
    failure: "failed",
    lost: "lost",
    running: "running",
    cancelled: "cancelled",
};

function buildFact(build: string, buildId: string, buildAt: number, now: number): StripFact {
    if (!build) {
        return { key: "build", label: "Last build", value: "none yet", tone: "muted" };
    }
    const word = BuildWords[build] ?? build;
    const when = buildAt ? ` ${shortAgo(buildAt, now)}` : "";
    return {
        key: "build",
        label: "Last build",
        value: `${buildId ? buildId + " " : ""}${word}${when}`,
        tone: BuildTones[build] ?? "muted",
        title: buildAt ? `Started ${new Date(buildAt).toLocaleString()}` : undefined,
    };
}

function releaseFact(lastTag: string, releaseTag: string): StripFact {
    if (!lastTag && !releaseTag) {
        return { key: "release", label: "Release", value: "none yet", tone: "muted" };
    }
    if (!lastTag || lastTag === releaseTag) {
        return { key: "release", label: "Release", value: releaseTag, tone: "ok", title: "The last public release" };
    }
    if (!releaseTag) {
        return { key: "release", label: "Release", value: lastTag, tone: "ok", title: "The newest release tag" };
    }
    return {
        key: "release",
        label: "Release",
        value: `${lastTag} · public ${releaseTag}`,
        tone: "ok",
        title: `The newest release tag is ${lastTag}; the last public release is ${releaseTag}`,
    };
}

// "3 min ago", "5 h ago", "2 d ago": the strip is narrow.
export function shortAgo(at: number, now: number): string {
    const minutes = Math.max(0, Math.round((now - at) / 60_000));
    if (minutes < 1) {
        return "just now";
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
        return `${hours} h ago`;
    }
    return `${Math.round(hours / 24)} d ago`;
}

function unique(values: string[]): string[] {
    return [...new Set((values ?? []).filter((v) => !!v))];
}

export function stripDependency(member: GroupMember, dep: DependencyState): StripDependency {
    const source = dep.sourcename || dep.project;
    const branch = dep.branch || dep.ref || "";
    const paths = unique(dep.changed?.length ? dep.changed : dep.paths);
    const commits = dep.commits ?? [];
    const uncommitted = dep.uncommitted ?? [];
    const title =
        dep.state === "uncommitted"
            ? `Synced with ${source}, not committed`
            : `Behind ${source}${branch ? ` on ${branch}` : ""}${dep.synced ? "" : ": never synced"}`;
    return {
        key: `${dep.index}:${dep.project}`,
        source,
        branch,
        state: dep.state,
        title,
        paths: paths.slice(0, StripShownPaths),
        morePaths: Math.max(0, paths.length - StripShownPaths),
        commits: commits.slice(0, StripShownCommits).map((c) => ({
            sha: (c.sha ?? "").slice(0, 7),
            subject: c.subject ?? "",
            tickets: c.tickets ?? [],
        })),
        moreCommits: Math.max(0, commits.length - StripShownCommits),
        moreCommitsCapped: !!dep.morecommits,
        uncommitted: uncommitted.slice(0, StripShownFiles),
        moreUncommitted: Math.max(0, uncommitted.length - StripShownFiles),
        sync: dep.sync ? { dir: member.dir, project: source, index: dep.index } : null,
    };
}

const UnresolvedWords: Record<string, string> = {
    sourcenotfound: "source not found",
    branchnotfound: "branch not found",
    invalid: "invalid declaration",
    error: "could not be read",
};

function unresolvedLine(dep: DependencyState): string {
    const word = UnresolvedWords[dep.state];
    if (!word) {
        return null;
    }
    return `${dep.sourcename || dep.project}: ${word}`;
}

export function stripMember(member: GroupMember, current: boolean, now: number): StripMember {
    const state = member.state ?? {};
    const trunk = state.trunk || "the trunk";
    const deps = state.deps ?? [];
    const rtn: StripMember = {
        member,
        current,
        target: memberTarget(member, current),
        facts: [],
        note: null,
        noteTone: "muted",
        flagged: deps.filter(isFlaggedDependency).map((dep) => stripDependency(member, dep)),
        unresolved: deps.map(unresolvedLine).filter((line) => line != null),
    };
    if (state.missing) {
        rtn.note = "Its folder is missing";
        rtn.noteTone = "bad";
        return rtn;
    }
    if (!state.collectedat) {
        rtn.note = "Not read yet: Mission Control reads it once its workspace has been open";
    } else {
        rtn.facts.push(localCiFact(state.trunkci, trunk), remoteCiFact(state.remoteci, trunk));
    }
    rtn.facts.push(
        buildFact(state.build, state.buildid, state.buildat, now),
        releaseFact(state.lasttag, state.releasetag)
    );
    return rtn;
}

// The strip's entries, in the group's order (the rail's); empty when the tab's project is not in the group.
export function stripMembers(group: ProjectGroup, workspaceId: string, dir: string, now: number): StripMember[] {
    const members = group?.members ?? [];
    const currentIndex = members.findIndex((m) => isCurrentMember(m, workspaceId, dir));
    if (currentIndex < 0) {
        return [];
    }
    return members.map((m, i) => stripMember(m, i === currentIndex, now));
}
