// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the Project overview's four cards show (FR-MC-024, DS-MC-012), computed from what the core already hands every
// card: no new git or GitHub call. Kept apart from the components so the rules can be tested without the app.

import { CiRunRecord, CiState, CiStatusLabels } from "../mission/ci-model";
import { Milestone, plainText } from "../mission/github";
import { GithubState, MissionGit, RunRecord, RunStateLabels } from "../mission/mission-model";
import { RawCommit, RawTag } from "../mission/tree";
import { ReleaseState } from "../mission/versions";

const TypeRegex = /^([a-z]+)(\([^)]*\))?!?:/;
const NotesExcerptChars = 220;

export type CardTone = "running" | "success" | "failure" | "neutral";

export type ReleaseBar = { key: "feat" | "fix" | "other"; label: string; count: number; share: number };

export type MilestoneView = {
    title: string;
    url: string;
    percent: number;
    open: number;
    closed: number;
};

export type NextReleaseView = {
    // "v1.2.0 · derived · minor", until the header (FR-MC-021) holds the next version.
    caption: string;
    // What the bars count: "on develop, not yet on main", or "since v1.1.0" on a single-branch project.
    scope: string;
    total: number;
    bars: ReleaseBar[];
    milestone: MilestoneView;
    // Why no milestone shows, when none does.
    milestoneNote: string;
};

export type ReleaseView = { tag: string; date: string; excerpt: string };

export type ReleasesView = {
    rc: ReleaseView;
    public: ReleaseView;
    // "v1.0.0 will be the first.", when there is no public release yet.
    firstPublic: string;
};

export type NowLine = { label: string; text: string; tone: CardTone; title?: string };

export function commitKind(subject: string): "feat" | "fix" | "other" {
    const type = TypeRegex.exec(subject ?? "")?.[1] ?? "";
    return type === "feat" || type === "fix" ? type : "other";
}

export function releaseBars(commits: readonly RawCommit[]): { total: number; bars: ReleaseBar[] } {
    const counts = { feat: 0, fix: 0, other: 0 };
    for (const c of commits ?? []) {
        counts[commitKind(c.subject)]++;
    }
    const total = counts.feat + counts.fix + counts.other;
    const bar = (key: ReleaseBar["key"], label: string): ReleaseBar => ({
        key,
        label,
        count: counts[key],
        share: total === 0 ? 0 : counts[key] / total,
    });
    return { total, bars: [bar("feat", "features"), bar("fix", "fixes"), bar("other", "the rest")] };
}

function milestoneKey(title: string): string {
    return (title ?? "")
        .trim()
        .toLowerCase()
        .replace(/^milestone\s+/, "")
        .replace(/^v(?=\d)/, "");
}

// The milestone of the next version: its title names the version ("1.2.0", "v1.2.0") or its line ("v1" for 1.x.y);
// else the open milestone due first, else the first GitHub lists.
export function pickMilestone(milestones: readonly Milestone[], version: string): Milestone {
    const list = (milestones ?? []).filter((m) => m != null);
    if (list.length === 0) {
        return null;
    }
    if (version) {
        const exact = list.find((m) => milestoneKey(m.title) === version);
        if (exact) {
            return exact;
        }
        const line = list.find((m) => {
            const key = milestoneKey(m.title);
            return /^\d+(\.\d+)?$/.test(key) && version.startsWith(key + ".");
        });
        if (line) {
            return line;
        }
    }
    const dated = list.filter((m) => m.due_on).sort((a, b) => a.due_on.localeCompare(b.due_on));
    return dated[0] ?? list[0];
}

export function milestoneView(m: Milestone): MilestoneView {
    if (m == null) {
        return null;
    }
    const open = m.open_issues ?? 0;
    const closed = m.closed_issues ?? 0;
    return {
        title: m.title,
        url: m.html_url,
        percent: open + closed === 0 ? 0 : Math.round((closed / (open + closed)) * 100),
        open,
        closed,
    };
}

function milestoneNote(githubState: GithubState): string {
    if (githubState == null) {
        return "Milestone progress shows once GitHub has been read.";
    }
    if (githubState !== "ok") {
        return "Milestone progress needs the project on GitHub.";
    }
    return "No open milestone on GitHub.";
}

export function nextReleaseView(
    state: ReleaseState,
    git: Pick<MissionGit, "trunk" | "release" | "ahead" | "sincepublic" | "lastpublic">,
    milestones: readonly Milestone[],
    githubState: GithubState,
    tagPrefix = "v"
): NextReleaseView {
    if (state == null || git == null) {
        return null;
    }
    const { next } = state;
    const singleBranch = !git.release || git.release === git.trunk;
    const commits = singleBranch ? (git.sincepublic ?? []) : (git.ahead ?? []);
    const { total, bars } = releaseBars(commits);
    const how =
        next.how === "decision"
            ? "to decide"
            : next.how === "derived"
              ? `derived · ${next.level}`
              : "nothing to release";
    const scope = singleBranch
        ? git.lastpublic
            ? `since ${git.lastpublic}`
            : "on " + (git.trunk || "the trunk")
        : `on ${git.trunk}, not yet on ${git.release}`;
    const m = milestoneView(pickMilestone(milestones, next.version));
    return {
        caption: next.version ? `${tagPrefix}${next.version} · ${how}` : how,
        scope,
        total,
        bars,
        milestone: m,
        milestoneNote: m ? null : milestoneNote(githubState),
    };
}

// The start of a release's notes as one reads them: no headings, no tables, the first lines up to a few sentences.
export function notesExcerpt(notes: string, max = NotesExcerptChars): string {
    const text = plainText(notes ?? "")
        .replace(/\n{2,}/g, "\n")
        .trim();
    if (text.length <= max) {
        return text;
    }
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

function releaseOf(tag: RawTag): ReleaseView {
    if (tag == null) {
        return null;
    }
    return { tag: tag.name, date: tag.date, excerpt: notesExcerpt(tag.notes ?? tag.notesInternal ?? "") };
}

// Both come from the repository's tags (the collector reads them with git), so a project without GitHub shows them too.
export function releasesView(state: ReleaseState, tagPrefix = "v"): ReleasesView {
    if (state == null) {
        return null;
    }
    const rc = releaseOf(state.lastRc);
    const pub = releaseOf(state.lastPublic);
    return {
        rc,
        public: pub,
        firstPublic: pub == null && state.next.version ? `${tagPrefix}${state.next.version} will be the first.` : "",
    };
}

export function agoText(at: number, now = Date.now()): string {
    if (!at) {
        return "";
    }
    const minutes = Math.round((now - at) / 60_000);
    if (minutes < 1) {
        return "just now";
    }
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    if (minutes < 60) {
        return rtf.format(-minutes, "minute");
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
        return rtf.format(-hours, "hour");
    }
    return rtf.format(-Math.round(hours / 24), "day");
}

export function formatWhen(iso: string): string {
    return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function clockElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return h > 0 ? `${h}:${mmss}` : mmss;
}

function ciTone(status: string): CardTone {
    if (status === "running" || status === "queued") {
        return "running";
    }
    if (status === "success") {
        return "success";
    }
    if (status === "failure" || status === "interrupted") {
        return "failure";
    }
    return "neutral";
}

// The local CI on the trunk: running with its elapsed time, else its last run's result and when, else the verdict
// the CI keeps for the branch, else "not run".
export function trunkCiLine(ci: CiState, trunk: string, now = Date.now()): NowLine {
    if (!trunk) {
        return null;
    }
    const label = `CI on ${trunk}`;
    const runs = (ci?.runs ?? []).filter((r) => r.branch === trunk);
    const running: CiRunRecord = ci?.running ? runs.find((r) => r.id === ci.running) : null;
    if (running) {
        const done = running.jobs.filter((j) => j.status === "success").length;
        return {
            label,
            text: `running · ${clockElapsed(now - running.startedat)}`,
            tone: "running",
            title: `${done} of ${running.jobs.length} jobs done`,
        };
    }
    const last = runs.find((r) => r.status !== "queued");
    if (last) {
        const when = agoText(last.finishedat || last.startedat, now);
        return {
            label,
            text: [CiStatusLabels[last.status] ?? last.status, when].filter((s) => s).join(" · "),
            tone: ciTone(last.status),
        };
    }
    const verdict = (ci?.branches ?? []).find((b) => b.name === trunk)?.verdict;
    if (verdict === "success" || verdict === "failure" || verdict === "running") {
        return {
            label,
            text: verdict === "success" ? "passed" : verdict === "failure" ? "failed" : "running",
            tone: ciTone(verdict),
        };
    }
    return { label, text: "not run", tone: "neutral" };
}

function runTone(state: string): CardTone {
    if (state === "running") {
        return "running";
    }
    if (state === "success") {
        return "success";
    }
    if (state === "failure" || state === "lost") {
        return "failure";
    }
    return "neutral";
}

export function lastBuildLine(build: RunRecord, now = Date.now()): NowLine {
    if (build == null) {
        return { label: "No local build yet", text: "", tone: "neutral" };
    }
    const label = build.title || build.stepid;
    const state = RunStateLabels[build.state] ?? build.state;
    const text =
        build.state === "running"
            ? `${state} · ${clockElapsed(now - build.startedat)}`
            : [state, agoText(build.finishedat || build.startedat, now)].filter((s) => s).join(" · ");
    return {
        label,
        text,
        tone: runTone(build.state),
        title: build.commit ? `Commit ${build.commit.slice(0, 7)}` : null,
    };
}
