// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the line map draws (FR-MC-022, DS-MC-013), in time rather than pixels: develop and main, the branches that left
// and rejoined develop, the ones still open, every version tag as a station with the develop commit it came from,
// and the next public release ahead. Computed from what the collector returns; a pure function, tested without the
// app. line-map-geometry.ts turns it into pixels.
//
// Merged branches come from two sources. A project that merges with merge commits has them in git.merges (wavesrv
// walked each merge back to its fork). A project that rebases or squashes keeps no trace of its branches in git:
// they are inferred from develop's own history, where each run of commits on one ticket stands for one branch (a
// rebase may land several tickets at once, interleaved), which left develop when its first commit was written (a
// rebase keeps author dates).

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
// Open branches drawn before the merged ones, the most recently touched.
const OpenFirst = 2;
// How far down main's history a tag's develop commit is looked for.
const SourceSearchDepth = 50;
// The collector reads at most this many commits of an open branch (branchLogLimit in pkg/molten/mission/git.go).
export const BranchCommitsRead = 150;
// must match maxMergeCommits and trunkLogLimit in pkg/molten/mission/git.go
const MergeCommitsRead = 150;
export const TrunkCommitsRead = 300;

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
    // When the window starts before the oldest develop commit the collector read (it reads a bounded history), the
    // date from which the map is complete; null when it is complete over the whole window.
    historyFrom: number;
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

// develop's commits (oldest first) grouped by ticket: a commit joins its ticket's latest group when it follows it
// directly, or when both landed together (one rebase interleaves tickets). A commit without a ticket, or a merge
// commit (its branch is in git.merges), breaks the run. So one ticket landed commit by commit stays one branch, and
// a ticket coming back later is a new one.
function ticketGroups(commits: readonly RawCommit[]): { ticket: string; commits: RawCommit[] }[] {
    const rtn: { ticket: string; commits: RawCommit[]; last: number }[] = [];
    const latest = new Map<string, (typeof rtn)[number]>();
    let previous: string = null;
    for (const c of commits) {
        const ticket = (c.parents?.length ?? 1) > 1 ? null : readableSubject(c.subject).ticket;
        if (!ticket) {
            previous = null;
            continue;
        }
        const at = time(c.date);
        const group = latest.get(ticket);
        if (group && (previous === ticket || Math.abs(at - group.last) <= BurstGap)) {
            group.commits.push(c);
            group.last = at;
        } else {
            const fresh = { ticket, commits: [c], last: at };
            rtn.push(fresh);
            latest.set(ticket, fresh);
        }
        previous = ticket;
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
): { branches: LineMapBranch[]; inBranch: Set<string> } {
    const branches: LineMapBranch[] = [];
    const inBranch = new Set<string>();
    const oldestFirst = trunk.filter((c) => time(c.date) >= start && time(c.date) <= now + Day).reverse();
    for (const { ticket, commits } of ticketGroups(oldestFirst)) {
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
    return { branches, inBranch };
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
        // A back-merge of the long-lived branches (main into develop) or of a tag is no branch of work.
        if (parsed.name === git.release || parsed.name === git.trunk || /^Merge tag /.test(m.subject)) {
            continue;
        }
        const name = parsed.name ?? m.subject;
        const ticket = branchTicket(name);
        const forkAt = time(m.fork?.date);
        // A walk that stopped at its cap never reached develop: its first commit is not where the branch began.
        const firstAt = m.commits < MergeCommitsRead ? time(m.firstdate) : NaN;
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
            url: links.pull(row.pr?.number) ?? links.issue(ticket),
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
// A develop commit committed after the tag cannot be what the tag shipped (a fix picked back from main, say).
export function makeSourceFinder(
    trunk: readonly RawCommit[],
    release: readonly RawCommit[]
): (tag: { sha: string; at: number }) => RawCommit {
    const onTrunk = new Map(trunk.map((c) => [c.sha, c]));
    const copies = new Map<string, RawCommit>();
    for (const c of trunk) {
        if (c.authordate) {
            copies.set(`${c.subject}\u0000${c.authordate}`, c);
        }
    }
    const releaseIndex = new Map(release.map((c, i) => [c.sha, i]));
    return (tag) => {
        const before = (c: RawCommit) => (c != null && time(c.date) <= tag.at + DirectGap ? c : null);
        const exact = onTrunk.get(tag.sha);
        if (exact) {
            return exact;
        }
        const from = releaseIndex.get(tag.sha);
        if (from != null) {
            for (let i = from; i < Math.min(release.length, from + SourceSearchDepth); i++) {
                const c = release[i];
                const hit =
                    before(onTrunk.get(c.sha)) ??
                    (c.parents?.length > 1 ? before(onTrunk.get(c.parents[1])) : null) ??
                    (c.authordate ? before(copies.get(`${c.subject}\u0000${c.authordate}`)) : null);
                if (hit) {
                    return hit;
                }
            }
        }
        return trunk.find((c) => time(c.date) <= tag.at) ?? null;
    };
}

export function stationSource(
    tag: { sha: string; at: number },
    trunk: readonly RawCommit[],
    release: readonly RawCommit[]
): RawCommit {
    return makeSourceFinder(trunk, release)(tag);
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
    // A branch squashed or rebased into develop and not deleted still holds commits develop lacks (their shas changed):
    // its ticket landed after its last commit, so it is the merged branch already drawn, not work in progress.
    const landed = new Map<string, number>();
    for (const b of merged) {
        if (b.ticket) {
            landed.set(b.ticket, Math.max(landed.get(b.ticket) ?? -Infinity, b.merge));
        }
    }
    const opened = openBranches(input, links).filter(
        (b) => !(b.ticket && landed.get(b.ticket) >= Math.max(...b.commits.map((c) => c.at).filter(Number.isFinite)))
    );
    // Lane order: the work in progress most recently touched first (what one looks for), then the merged branches,
    // then the other open ones. An open branch holds its lane up to now, so forgotten ones go last and cannot push
    // the window's merges past the lane cap.
    const byFork = (a: LineMapBranch, b: LineMapBranch) => a.fork - b.fork || a.id.localeCompare(b.id);
    const lastTouch = (b: LineMapBranch) => Math.max(b.fork, ...b.commits.map((c) => c.at).filter(Number.isFinite));
    const recent = [...opened].sort((a, b) => lastTouch(b) - lastTouch(a)).slice(0, OpenFirst);
    const rest = opened.filter((b) => !recent.includes(b));
    const branches = [...recent.sort(byFork), ...merged.sort(byFork), ...rest.sort(byFork)];

    const commits = trunkCommits
        .filter((c) => !inferred.inBranch.has(c.sha) && (c.parents?.length ?? 1) <= 1)
        .map(toCommit)
        .filter((c) => c.at >= start && c.at <= now + Day);

    const tree = toTreeData(git);
    const rules = treeRules(tree);
    const released = new Set((input.releases ?? []).filter((r) => !r.isDraft).map((r) => r.tagName));
    const all: LineMapStation[] = [];
    const findSource = single ? null : makeSourceFinder(trunkCommits, releaseCommits);
    for (const tag of tree.tags) {
        const kind = stationKind(tag.name, rules);
        const at = time(tag.date);
        if (kind == null || !Number.isFinite(at)) {
            continue;
        }
        // Only the window's stations draw a connector; the earlier ones are listed, not drawn.
        const source = findSource && at >= start ? findSource({ sha: tag.sha, at }) : null;
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
    const oldestRead = trunkCommits.length >= TrunkCommitsRead ? time(trunkCommits[trunkCommits.length - 1].date) : NaN;
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
        historyFrom: oldestRead > start ? oldestRead : null,
    };
}

// What of the collector's answer the map draws, as a key: equal keys draw the same map, so a snapshot that only
// changed elsewhere (refreshing, GitHub's runs) rebuilds nothing.
export function gitFingerprint(git: MissionGit): string {
    if (git == null) {
        return "";
    }
    const branches = (git.branches ?? []).map(
        (b) => `${b.name}@${b.sha}:${b.commits?.length ?? 0}:${b.fork?.sha ?? ""}`
    );
    const tags = (git.tags ?? []).map((t) => `${t.name}@${t.sha}:${t.date}:${(t.notes ?? "").length}`);
    const merges = (git.merges ?? []).map((m) => m.sha);
    return [
        git.trunk,
        git.release,
        git.remoteurl ?? "",
        git.tagprefix ?? "",
        git.firstpublic ?? "",
        git.lastpublic ?? "",
        `${git.ahead?.length ?? 0}:${git.ahead?.[0]?.sha ?? ""}`,
        `${git.sincepublic?.length ?? 0}:${git.sincepublic?.[0]?.sha ?? ""}`,
        branches.join(","),
        tags.join(","),
        merges.join(","),
    ].join("|");
}

export function prsFingerprint(prs: readonly PullRequest[]): string {
    return (prs ?? [])
        .map((p) => {
            const checks = (p.statusCheckRollup ?? [])
                .map((c) => `${c.status ?? ""}${c.conclusion ?? ""}${c.state ?? ""}`)
                .join("");
            return `${p.headRefName}#${p.number}:${p.isDraft}:${p.mergeStateStatus ?? ""}:${checks}`;
        })
        .join(",");
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
