// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the group strip of the Project tab says (FR-MC-028, DS-MC-012): every member of the linked project's product, in
// rail order, with its state as the collector last read it, the stale flags and their Sync. It shows no other action:
// each member's Run CI, Build local, Release and Clean branches stay in its own workspace.

import { getLocale, t } from "../i18n/i18n";
import { dependencyLabel } from "./dep-sync-model";
import { DependencyState, GroupMember, isFlaggedDependency, ProjectGroup } from "./group-model";
import { labelRecord } from "./mission-i18n";

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
    // The last sync as wavesrv knows it, from any window or `molten project sync`: running, or why it failed.
    syncing: boolean;
    syncNote: string;
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
    const label = t("mc.strip.localCi");
    const title = t("mc.strip.localCiTitle", { trunk });
    switch (trunkci) {
        case "success":
            return { key: "localci", label, value: t("mc.strip.passed"), tone: "ok", title };
        case "failure":
            return { key: "localci", label, value: t("mc.strip.failed"), tone: "bad", title };
        case "running":
            return { key: "localci", label, value: t("mc.strip.running"), tone: "running", title };
        case "missing":
            return { key: "localci", label, value: t("mc.strip.noVerdict"), tone: "muted", title };
        default:
            return {
                key: "localci",
                label,
                value: t("mc.strip.none"),
                tone: "muted",
                title: t("mc.strip.noLocalCi"),
            };
    }
}

function remoteCiFact(remoteci: string, trunk: string): StripFact {
    const label = t("mc.strip.githubCi");
    const title = t("mc.strip.githubCiTitle", { trunk });
    switch (remoteci) {
        case "success":
            return { key: "remoteci", label, value: t("mc.strip.passed"), tone: "ok", title };
        case "failure":
            return { key: "remoteci", label, value: t("mc.strip.failed"), tone: "bad", title };
        case "running":
            return { key: "remoteci", label, value: t("mc.strip.running"), tone: "running", title };
        default:
            return { key: "remoteci", label, value: t("mc.strip.unknown"), tone: "muted", title };
    }
}

const BuildTones: Record<string, StripTone> = {
    success: "ok",
    failure: "bad",
    lost: "bad",
    running: "running",
    cancelled: "muted",
};

const BuildWords = labelRecord("mc.strip.build", ["success", "failure", "lost", "running", "cancelled"]) as Record<
    string,
    string
>;

function buildFact(build: string, buildId: string, buildAt: number, now: number): StripFact {
    const label = t("mc.strip.lastBuild");
    if (!build) {
        return { key: "build", label, value: t("mc.strip.noneYet"), tone: "muted" };
    }
    const word = BuildWords[build] ?? build;
    const when = buildAt ? ` ${shortAgo(buildAt, now)}` : "";
    return {
        key: "build",
        label,
        value: `${buildId ? buildId + " " : ""}${word}${when}`,
        tone: BuildTones[build] ?? "muted",
        title: buildAt ? t("mc.strip.started", { when: new Date(buildAt).toLocaleString(getLocale()) }) : undefined,
    };
}

function releaseFact(lastTag: string, releaseTag: string): StripFact {
    const label = t("mc.strip.release");
    if (!lastTag && !releaseTag) {
        return { key: "release", label, value: t("mc.strip.noneYet"), tone: "muted" };
    }
    if (!lastTag || lastTag === releaseTag) {
        return { key: "release", label, value: releaseTag, tone: "ok", title: t("mc.strip.lastPublic") };
    }
    if (!releaseTag) {
        return { key: "release", label, value: lastTag, tone: "ok", title: t("mc.strip.newestTag") };
    }
    return {
        key: "release",
        label,
        value: t("mc.strip.tagAndPublic", { tag: lastTag, public: releaseTag }),
        tone: "ok",
        title: t("mc.strip.tagAndPublicTitle", { tag: lastTag, public: releaseTag }),
    };
}

// "3 min ago", "5 h ago", "2 d ago": the strip is narrow.
export function shortAgo(at: number, now: number): string {
    const minutes = Math.max(0, Math.round((now - at) / 60_000));
    if (minutes < 1) {
        return t("mc.time.justNow");
    }
    if (minutes < 60) {
        return t("mc.time.minAgo", { count: minutes });
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
        return t("mc.time.hAgo", { count: hours });
    }
    return t("mc.time.dAgo", { count: Math.round(hours / 24) });
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
    const behindKey = dep.synced
        ? branch
            ? "mc.strip.behindOn"
            : "mc.strip.behind"
        : branch
          ? "mc.strip.behindOnNever"
          : "mc.strip.behindNever";
    const title =
        dep.state === "uncommitted" ? t("mc.strip.syncedNotCommitted", { source }) : t(behindKey, { source, branch });
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
        syncing: dep.lastsync?.state === "running",
        syncNote: lastSyncNote(dep),
    };
}

// "syncing…" while a sync runs, "last sync failed (exit 4)" after one that failed since the source changed.
export function lastSyncNote(dep: DependencyState): string {
    const label = dependencyLabel(dep);
    if (dep?.lastsync?.state === "running") {
        return label;
    }
    const stale = t("mc.depSync.label.stale") + ", ";
    return label.startsWith(stale) ? label.slice(stale.length) : "";
}

const UnresolvedWords = labelRecord("mc.depSync.label", ["sourceNotFound", "branchNotFound", "invalid", "error"]);

const UnresolvedKeys: Record<string, keyof typeof UnresolvedWords> = {
    sourcenotfound: "sourceNotFound",
    branchnotfound: "branchNotFound",
    invalid: "invalid",
    error: "error",
};

function unresolvedLine(dep: DependencyState): string {
    const key = UnresolvedKeys[dep.state];
    if (!key) {
        return null;
    }
    return `${dep.sourcename || dep.project}: ${UnresolvedWords[key]}`;
}

export function stripMember(member: GroupMember, current: boolean, now: number): StripMember {
    const state = member.state ?? {};
    const trunk = state.trunk || t("mc.builds.theTrunk");
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
        rtn.note = t("mc.strip.folderMissing");
        rtn.noteTone = "bad";
        return rtn;
    }
    if (!state.collectedat) {
        rtn.note = t("mc.strip.notRead");
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
