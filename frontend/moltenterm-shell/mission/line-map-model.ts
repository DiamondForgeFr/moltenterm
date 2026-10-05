// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the line map draws (FR-MC-022, DS-MC-013), in time rather than pixels: develop and main, the branches that left
// and rejoined develop, the ones still open, every version tag as a station with the develop commit it came from,
// and the next public release ahead. Computed from what the collector returns; a pure function, tested without the
// app. line-map-geometry.ts turns it into pixels.
//
// Merged branches come from two sources. A project that merges with merge commits has them in git.merges (wavesrv
// walked each merge back to its fork). A project that rebases or squashes keeps no trace of its branches in git:
// they are inferred from develop's own history, where a merge lands as a burst of commits written at the same
// moment, and each ticket number in a burst stands for one branch, which left develop when its first commit was
// written (a rebase keeps author dates).

import { BranchPr, projectBranchRows } from "../project/project-model";
import { channelOfTag, DefaultTagPrefix, parseVersion, VersionRules } from "../releases/versions";
import { CiBranch, CiVerdictStatus } from "./ci-model";
import { GithubRelease, PullRequest } from "./github";
import { MissionGit, RawCommit, toTreeData } from "./mission-model";
import { isPrereleaseTag, readableSubject, releaseState, treeRules } from "./versions";

const Day = 86_400_000;
// Commits a single merge or rebase lands are committed within this of each other.
const BurstGap = 120_000;
// A ticket's commits written this close to their landing were committed on develop itself, not on a branch.
const DirectGap = 60_000;
// How far down main's history a tag's develop commit is looked for.
const SourceSearchDepth = 50;
// The collector reads at most this many commits of an open branch (branchLogLimit in pkg/molten/mission/git.go).
export const BranchCommitsRead = 150;

export const DefaultLineMapDays = 21;
export const DefaultFullLineMapDays = 60;
export const LineMapDayChoices = [7, 14, 21, 30, 60, 90];
export const FullLineMapDayChoices = [7, 14, 21, 30, 60, 90, 180];

export type LineMapCommit = { sha: string; at: number; date: string; subject: string };

export type LineMapBranch = {
    id: string;
    name: string;
    ticket: string;
    state: "merged" | "open";
    // When it left develop; false when nothing tells (a squash merge), and the drawing makes it short.
    fork: number;
    forkKnown: boolean;
    // When it rejoined develop; null while open.
    merge: number;
    mergeSha: string;
    // Its own commits when known (inferred branches, open ones), newest first; count holds the number either way.
    commits: LineMapCommit[];
    count: number;
    // The count stops at what the collector reads.
    countCapped: boolean;
    pr: BranchPr;
    prNumber: number;
    ci: CiVerdictStatus;
    url: string;
};

export type StationKind = "rc" | "public";

export type LineMapStation = {
    name: string;
    sha: string;
    at: number;
    date: string;
    kind: StationKind;
    notes: string;
    // The develop commit pushed to main for this tag; null when develop's history does not reach it.
    source: LineMapCommit;
    latest: boolean;
    url: string;
};

export type LineMapTerminus = {
    version: string;
    tag: string;
    how: "decision" | "derived" | "nothing";
    reason: string;
    waiting: number;
};

export type LineMapModel = {
    start: number;
    now: number;
    days: number;
    trunk: string;
    // null in a single-branch project: everything happens on the trunk.
    release: string;
    head: LineMapCommit;
    // develop's own commits in the window, outside any branch.
    commits: LineMapCommit[];
    branches: LineMapBranch[];
    stations: LineMapStation[];
    // Tags older than the window, newest first: one "earlier" marker.
    earlier: LineMapStation[];
    terminus: LineMapTerminus;
    github: string;
};

export type LineMapInput = {
    git: MissionGit;
    prs?: readonly PullRequest[];
    ciBranches?: readonly CiBranch[];
    releases?: readonly GithubRelease[];
    now: number;
    days: number;
};

function time(iso: string): number {
    const t = new Date(iso ?? "").getTime();
    return Number.isFinite(t) ? t : NaN;
}

function toCommit(c: RawCommit): LineMapCommit {
    return { sha: c.sha, at: time(c.date), date: c.date, subject: c.subject };
}

function enc(part: string): string {
    return part
        .split("/")
        .map((p) => encodeURIComponent(p))
        .join("/");
}

// The branch a merge commit names: GitHub's "Merge pull request #12 from owner/feature/12-x", git's
// "Merge branch 'feature/12-x' into develop" or "Merge remote-tracking branch 'origin/x'".
export function mergedBranchName(subject: string): { name: string; pr: number } {
    const text = subject ?? "";
    const pull = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(text);
    if (pull) {
        return { name: pull[2], pr: Number(pull[1]) };
    }
    const branch = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(text);
    if (branch) {
        return { name: branch[1].replace(/^origin\//, ""), pr: null };
    }
    return { name: null, pr: null };
}

// The ticket a branch name carries (feature/12-x, fix/12, 12-x).
export function branchTicket(name: string): string {
    return /(?:^|\/)(\d+)(?:[-_]|$)/.exec(name ?? "")?.[1] ?? null;
}

// A squash merge's subject ends with its pull request: "feat(#12): thing (#34)".
function squashPr(subject: string): number {
    const m = /\(#(\d+)\)\s*$/.exec(subject ?? "");
    return m ? Number(m[1]) : null;
}

function subjectType(subject: string): string {
    return /^([a-z]+)(?:\([^)]*\))?!?:/.exec(subject ?? "")?.[1] ?? "";
}

// The name an inferred branch gets: the real one when a branch or an open pull request still carries the ticket,
// else the project's naming (feature/N, fix/N), else the ticket alone.
function inferredName(ticket: string, commits: readonly RawCommit[], known: ReadonlyMap<string, string>): string {
    const real = known.get(ticket);
    if (real) {
        return real;
    }
    const types = commits.map((c) => subjectType(c.subject));
    if (types.includes("feat")) {
        return `feature/${ticket}`;
    }
    if (types.includes("fix")) {
        return `fix/${ticket}`;
    }
    return `#${ticket}`;
}

function knownNames(git: MissionGit, prs: readonly PullRequest[]): Map<string, string> {
    const rtn = new Map<string, string>();
    const names = [...(prs ?? []).map((p) => p.headRefName), ...(git.branches ?? []).map((b) => b.name)];
    for (const name of names) {
        const ticket = branchTicket(name);
        if (ticket && !rtn.has(ticket) && name !== git.trunk && name !== git.release) {
            rtn.set(ticket, name);
        }
    }
    return rtn;
}

type Burst = RawCommit[];

// Consecutive commits landed together, oldest first. Merge commits stand apart: their branch is in git.merges.
function bursts(commits: readonly RawCommit[]): Burst[] {
    const rtn: Burst[] = [];
    let current: Burst = [];
    let last = NaN;
    for (const c of commits) {
        if ((c.parents?.length ?? 1) > 1) {
            if (current.length) {
                rtn.push(current);
            }
            current = [];
            last = NaN;
            continue;
        }
        const at = time(c.date);
        if (current.length && !(Math.abs(at - last) <= BurstGap)) {
            rtn.push(current);
            current = [];
        }
        current.push(c);
        last = at;
    }
    if (current.length) {
        rtn.push(current);
    }
    return rtn;
}

function githubLinks(github: string) {
    return {
        commit: (sha: string) => (github && sha ? `${github}/commit/${sha}` : null),
        pull: (n: number) => (github && n ? `${github}/pull/${n}` : null),
        issue: (ticket: string) => (github && ticket ? `${github}/issues/${ticket}` : null),
        tag: (name: string, released: boolean) =>
            github ? `${github}/${released ? "releases/tag" : "tree"}/${enc(name)}` : null,
    };
}

// The branches develop's own history shows, for a project without merge commits.
function inferBranches(
    trunk: readonly RawCommit[],
    start: number,
    now: number,
    known: ReadonlyMap<string, string>,
    links: ReturnType<typeof githubLinks>
): { branches: LineMapBranch[]; direct: Set<string> } {
    const branches: LineMapBranch[] = [];
    const inBranch = new Set<string>();
    const oldestFirst = trunk.filter((c) => time(c.date) >= start && time(c.date) <= now + Day).reverse();
    for (const burst of bursts(oldestFirst)) {
        const byTicket = new Map<string, RawCommit[]>();
        for (const c of burst) {
            const ticket = readableSubject(c.subject).ticket;
            if (!ticket) {
                continue;
            }
            byTicket.set(ticket, [...(byTicket.get(ticket) ?? []), c]);
        }
        for (const [ticket, commits] of byTicket) {
            const landed = commits[commits.length - 1];
            const merge = time(landed.date);
            const written = Math.min(...commits.map((c) => time(c.authordate || c.date)).filter(Number.isFinite));
            const pr = squashPr(landed.subject);
            if (!(merge - written > DirectGap) && pr == null) {
                continue;
            }
            const forkKnown = merge - written > DirectGap;
            for (const c of commits) {
                inBranch.add(c.sha);
            }
            const newestFirst = [...commits].reverse();
            branches.push({
                id: `merged:${landed.sha}`,
                name: inferredName(ticket, commits, known),
                ticket,
                state: "merged",
                fork: forkKnown ? written : merge,
                forkKnown,
                merge,
                mergeSha: landed.sha,
                commits: newestFirst.map(toCommit),
                count: commits.length,
                countCapped: false,
                pr: null,
                prNumber: pr,
                ci: null,
                url: links.pull(pr) ?? links.issue(ticket) ?? links.commit(landed.sha),
            });
        }
    }
    return { branches, direct: inBranch };
}

function mergeBranches(
    git: MissionGit,
    start: number,
    now: number,
    links: ReturnType<typeof githubLinks>
): LineMapBranch[] {
    const rtn: LineMapBranch[] = [];
    for (const m of git.merges ?? []) {
        const merge = time(m.date);
        if (!(merge >= start && merge <= now + Day)) {
            continue;
        }
        const parsed = mergedBranchName(m.subject);
        // A back-merge of the long-lived branches (main into develop) is no branch of work.
        if (parsed.name === git.release || parsed.name === git.trunk) {
            continue;
        }
        const name = parsed.name ?? m.subject;
        const ticket = branchTicket(name);
        const forkAt = time(m.fork?.date);
        const firstAt = time(m.firstdate);
        const fork = Number.isFinite(forkAt) ? forkAt : firstAt;
        const forkKnown = Number.isFinite(fork) && fork < merge;
        rtn.push({
            id: `merged:${m.sha}`,
            name,
            ticket,
            state: "merged",
            fork: forkKnown ? fork : merge,
            forkKnown,
            merge,
            mergeSha: m.sha,
            commits: [],
            count: m.commits,
            countCapped: false,
            pr: null,
            prNumber: parsed.pr,
            ci: null,
            url: links.pull(parsed.pr) ?? links.issue(ticket) ?? links.commit(m.sha),
        });
    }
    return rtn;
}

function openBranches(input: LineMapInput, links: ReturnType<typeof githubLinks>): LineMapBranch[] {
    const { git } = input;
    const rows = projectBranchRows(git, input.ciBranches, input.prs).rows.filter((r) => r.role === "feature");
    const rtn: LineMapBranch[] = [];
    for (const row of rows) {
        const branch = (git.branches ?? []).find((b) => b.name === row.name);
        if (branch == null) {
            continue;
        }
        const commits = (branch.commits ?? []).map(toCommit);
        const oldest = commits.length ? Math.min(...commits.map((c) => c.at).filter(Number.isFinite)) : NaN;
        const forkAt = time(branch.fork?.date);
        const fork = Number.isFinite(forkAt) ? forkAt : Number.isFinite(oldest) ? oldest : time(branch.date);
        const ticket = branchTicket(row.name);
        rtn.push({
            id: `open:${row.name}`,
            name: row.name,
            ticket,
            state: "open",
            fork: Number.isFinite(fork) ? Math.min(fork, input.now) : input.now,
            forkKnown: Number.isFinite(forkAt),
            merge: null,
            mergeSha: null,
            commits,
            count: commits.length,
            countCapped: commits.length >= BranchCommitsRead,
            pr: row.pr,
            prNumber: row.pr?.number ?? null,
            ci: row.ci,
            url: row.pr?.url && /^https:\/\//.test(row.pr.url) ? row.pr.url : links.issue(ticket),
        });
    }
    return rtn;
}

// A tag's kind, or null when it is not one of the project's releases (below versions.firstpublic). A tag outside the
// strict X.Y.Z[-N] form still counts, by Notulia's dash rule.
export function stationKind(name: string, rules: VersionRules): StationKind {
    const channel = channelOfTag(rules, name);
    if (channel) {
        return channel;
    }
    const prefix = rules.tagprefix || DefaultTagPrefix;
    if (!name.startsWith(prefix) || parseVersion(name.slice(prefix.length)) != null) {
        return null;
    }
    return isPrereleaseTag(name, prefix) ? "rc" : "public";
}

// The develop commit pushed to main for a tag: the tag commit itself when develop has it, else, down main's history
// from the tag, the first commit develop has, merged from develop (second parent), or copied from develop by a
// rebase or a cherry-pick (same subject and author date). Failing all, the last develop commit before the tag.
export function stationSource(
    tag: { sha: string; at: number },
    trunk: readonly RawCommit[],
    release: readonly RawCommit[]
): RawCommit {
    const onTrunk = new Map(trunk.map((c) => [c.sha, c]));
    const exact = onTrunk.get(tag.sha);
    if (exact) {
        return exact;
    }
    const copies = new Map<string, RawCommit>();
    for (const c of trunk) {
        if (c.authordate) {
            copies.set(`${c.subject}\u0000${c.authordate}`, c);
        }
    }
    const from = release.findIndex((c) => c.sha === tag.sha);
    if (from >= 0) {
        for (let i = from; i < Math.min(release.length, from + SourceSearchDepth); i++) {
            const c = release[i];
            const hit =
                onTrunk.get(c.sha) ??
                (c.parents?.length > 1 ? onTrunk.get(c.parents[1]) : null) ??
                (c.authordate ? copies.get(`${c.subject}\u0000${c.authordate}`) : null);
            if (hit) {
                return hit;
            }
        }
    }
    return trunk.find((c) => time(c.date) <= tag.at) ?? null;
}

export function buildLineMap(input: LineMapInput): LineMapModel {
    const { git, now, days } = input;
    const start = now - days * Day;
    const github = git.remoteurl ?? "";
    const links = githubLinks(github);
    const single = !git.release || git.release === git.trunk;
    const named = (name: string) => (git.branches ?? []).find((b) => b.name === name);
    const trunkCommits = named(git.trunk)?.commits ?? [];
    const releaseCommits = single ? [] : (named(git.release)?.commits ?? []);
    // Both sources together: a project that merges with merge commits may still rebase now and then, and a commit made
    // on develop itself is never taken for a branch (its author and commit dates meet).
    const known = knownNames(git, input.prs);
    const inferred = inferBranches(trunkCommits, start, now, known, links);
    const merged = [...inferred.branches, ...mergeBranches(git, start, now, links)];
    const opened = openBranches(input, links);
    const branches = [...merged, ...opened].sort((a, b) => a.fork - b.fork || a.id.localeCompare(b.id));

    const commits = trunkCommits
        .filter((c) => !inferred.direct.has(c.sha) && (c.parents?.length ?? 1) <= 1)
        .map(toCommit)
        .filter((c) => c.at >= start && c.at <= now + Day);

    const tree = toTreeData(git);
    const rules = treeRules(tree);
    const released = new Set((input.releases ?? []).filter((r) => !r.isDraft).map((r) => r.tagName));
    const all: LineMapStation[] = [];
    for (const tag of tree.tags) {
        const kind = stationKind(tag.name, rules);
        const at = time(tag.date);
        if (kind == null || !Number.isFinite(at)) {
            continue;
        }
        const source = single ? null : stationSource({ sha: tag.sha, at }, trunkCommits, releaseCommits);
        all.push({
            name: tag.name,
            sha: tag.sha,
            at,
            date: tag.date,
            kind,
            notes: tag.notes ?? tag.notesInternal,
            source: source ? toCommit(source) : null,
            latest: false,
            url: links.tag(tag.name, released.has(tag.name)),
        });
    }
    all.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    if (all.length) {
        all[all.length - 1].latest = true;
    }
    const stations = all.filter((s) => s.at >= start && s.at <= now + Day);
    const earlier = all.filter((s) => s.at < start).reverse();

    const state = releaseState(tree.tags, git.ahead ?? [], git.sincepublic ?? [], rules);
    const prefix = rules.tagprefix || DefaultTagPrefix;
    const terminus: LineMapTerminus = {
        version: state.next.version,
        tag: state.next.version ? prefix + state.next.version : null,
        how: state.next.how,
        reason: state.next.reason,
        waiting: state.pending.total,
    };

    const headCommit = trunkCommits[0];
    return {
        start,
        now,
        days,
        trunk: git.trunk,
        release: single ? null : git.release,
        head: headCommit ? toCommit(headCommit) : null,
        commits,
        branches,
        stations,
        earlier,
        terminus,
        github,
    };
}

export function commitUrl(model: LineMapModel, sha: string): string {
    return model.github && sha ? `${model.github}/commit/${sha}` : null;
}

// The window each project's map was left at, overview and full size apart, kept in the client's meta: it lives in
// the app's database, follows restarts, and never reaches the project.
export const LineMapMetaKey = "molten:linemap";

export type LineMapPrefs = Record<string, { days?: number; fulldays?: number }>;

export function lineMapDays(prefs: unknown, dir: string, full: boolean): number {
    const entry = prefs != null && typeof prefs === "object" ? (prefs as LineMapPrefs)[dir] : null;
    const value = full ? entry?.fulldays : entry?.days;
    const choices = full ? FullLineMapDayChoices : LineMapDayChoices;
    if (typeof value === "number" && choices.includes(value)) {
        return value;
    }
    return full ? DefaultFullLineMapDays : DefaultLineMapDays;
}

export function withLineMapDays(prefs: unknown, dir: string, full: boolean, days: number): LineMapPrefs {
    const current = prefs != null && typeof prefs === "object" ? (prefs as LineMapPrefs) : {};
    return { ...current, [dir]: { ...current[dir], [full ? "fulldays" : "days"]: days } };
}
