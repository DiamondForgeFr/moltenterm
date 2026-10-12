// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the Project overview's header band shows (FR-MC-021, DS-MC-012, DS-MC-013): the next station, what waits on
// the trunk, the ticker of those changes and the trunk the Run CI button runs on. Computed from what the core already
// hands every card (no new git or GitHub call), and kept apart from the component so it can be tested without the app.

import { CiState } from "../mission/ci-model";
import { Milestone, milestoneKey } from "../mission/github";
import { MissionGit, PipelineDef, RawCommit, toTreeData } from "../mission/mission-model";
import { ReleaseSession } from "../mission/release-model";
import { readableSubject, releaseState, treeRules } from "../mission/versions";
import { DefaultTagPrefix } from "../releases/versions";
import { commitKind, pendingCommits } from "./overview-cards-model";

const TickerMax = 40;

export type NextStationState = "decision" | "derived" | "chosen" | "nothing";

export type NextStation = {
    // "v1.2.0"; null when nothing justifies a release.
    tag: string;
    state: NextStationState;
    // The chip next to the version: "to decide", the bump level, "chosen"; null when there is no version.
    chip: string;
    // One line of explanation under the version.
    note: string;
};

export type WaitingCounts = {
    // "Waiting on develop"
    title: string;
    total: number;
    features: number;
    fixes: number;
    other: number;
    // "changes, not yet on main", "changes since v1.1.0"
    scope: string;
};

export type TickerItem = { key: string; ticket: string; text: string; url: string };

export type RunCiTarget = {
    branch: string;
    // The CI runs on the trunk right now.
    running: boolean;
    // Why the button cannot start a run; null when it can.
    disabled: string;
};

// The next station of the header, which the line map's terminus also reads (buildLineMap in
// ../mission/line-map-model.ts), so the header and the map name the same next version in the same state.
export function nextStation(git: MissionGit, session: ReleaseSession): NextStation {
    if (git == null) {
        return null;
    }
    const tree = toTreeData(git);
    const rules = treeRules(tree);
    const prefix = rules.tagprefix || DefaultTagPrefix;
    const { next } = releaseState(tree.tags, git.ahead ?? [], git.sincepublic ?? [], rules);
    // Picking the number happens in the Release menu: a public release on its way carries the chosen one.
    if (session?.channel === "public" && session.tag) {
        const decided = next.how !== "derived" || next.version !== session.version;
        return {
            tag: session.tag,
            state: decided ? "chosen" : "derived",
            chip: decided ? "chosen" : (next.level ?? null),
            note: decided
                ? `Chosen in the Release menu; the public release ${session.tag} is on its way.`
                : `The public release ${session.tag} is on its way.`,
        };
    }
    if (next.how === "nothing" || !next.version) {
        return { tag: null, state: "nothing", chip: null, note: next.reason || "Nothing to release yet." };
    }
    if (next.how === "decision") {
        return {
            tag: prefix + next.version,
            state: "decision",
            chip: "to decide",
            note: next.reason || "A choice, not a calculation: pick the number in the Release menu.",
        };
    }
    return {
        tag: prefix + next.version,
        state: "derived",
        chip: next.level ?? null,
        note: next.reason ? `Derived from the commits: ${next.reason}.` : "Derived from the commits.",
    };
}

export type StationSchedule = {
    // "due Oct 13"; null when the station's milestone has no due date.
    due: string;
    overdue: boolean;
    // The milestone after the station's; null when none is planned.
    then: { label: string; url: string; title: string };
};

// A milestone that names a version (1.1.0, v1.1.0, or a line, v2): buckets like "Later" never count.
const VersionKeyRegex = /^\d+(\.\d+)*$/;

function shortDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return "";
    }
    // GitHub stores a due date as a day: read it in UTC so that no time zone moves it to the day before.
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function utcDay(iso: string): string {
    return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

// The milestone of the station's version: its title names it ("1.2.0", "v1.2.0") or its line ("v1" for 1.x.y). No
// fallback here, unlike the Next release card: a date shown beside a version must be that version's.
export function stationMilestone(milestones: readonly Milestone[], version: string): Milestone {
    if (!version) {
        return null;
    }
    const list = (milestones ?? []).filter((m) => m != null);
    return (
        list.find((m) => milestoneKey(m.title) === version) ??
        list.find((m) => {
            const key = milestoneKey(m.title);
            return /^\d+(\.\d+)?$/.test(key) && version.startsWith(key + ".");
        }) ??
        null
    );
}

// The milestone after the station's, among the other open ones that name a version: the one due first (after the
// station's due date when it has one); without due dates, the next one created after it.
export function followingMilestone(milestones: readonly Milestone[], current: Milestone): Milestone {
    const others = (milestones ?? []).filter(
        (m) => m != null && m.number !== current?.number && VersionKeyRegex.test(milestoneKey(m.title))
    );
    const after = current?.due_on ? utcDay(current.due_on) : "";
    const dated = others
        .filter((m) => m.due_on && (!after || utcDay(m.due_on) > after))
        .sort((a, b) => a.due_on.localeCompare(b.due_on));
    if (dated.length > 0) {
        return dated[0];
    }
    if (current?.created_at == null) {
        return null;
    }
    const created = others
        .filter((m) => m.created_at && m.created_at > current.created_at)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return created[0] ?? null;
}

export function stationSchedule(
    station: NextStation,
    milestones: readonly Milestone[],
    prefix: string,
    now: number = Date.now()
): StationSchedule {
    const version = station?.tag ? station.tag.slice((prefix || DefaultTagPrefix).length) : "";
    const current = stationMilestone(milestones, version);
    if (current == null && !station?.tag) {
        return null;
    }
    const next = followingMilestone(milestones, current);
    const due = current?.due_on ? shortDate(current.due_on) : "";
    const rtn: StationSchedule = {
        due: due ? `due ${due}` : null,
        overdue: due !== "" && utcDay(current.due_on) < new Date(now).toISOString().slice(0, 10),
        then: null,
    };
    if (next != null) {
        const key = milestoneKey(next.title);
        const tag = /^\d+\.\d+\.\d+$/.test(key) ? (prefix || DefaultTagPrefix) + key : next.title;
        const date = next.due_on ? shortDate(next.due_on) : "";
        rtn.then = {
            label: `then ${tag}${date ? ` · ${date}` : ""}`,
            url: next.html_url,
            title: `Open the milestone ${next.title} on GitHub`,
        };
    }
    return rtn.due == null && rtn.then == null ? null : rtn;
}

function isSingleBranch(git: Pick<MissionGit, "trunk" | "release">): boolean {
    return !git.release || git.release === git.trunk;
}

export function waitingCounts(git: MissionGit): WaitingCounts {
    if (git == null) {
        return null;
    }
    const commits = pendingCommits(git);
    const counts = { feat: 0, fix: 0, other: 0 };
    for (const c of commits) {
        counts[commitKind(c.subject)]++;
    }
    const trunk = git.trunk || "the trunk";
    const changes = commits.length === 1 ? "change" : "changes";
    let scope = `${changes}, not yet on ${git.release}`;
    if (isSingleBranch(git)) {
        scope = git.lastpublic ? `${changes} since ${git.lastpublic}` : `${changes}, no public release yet`;
    }
    return {
        title: `Waiting on ${trunk}`,
        total: commits.length,
        features: counts.feat,
        fixes: counts.fix,
        other: counts.other,
        scope,
    };
}

export function countsLine(counts: WaitingCounts): string {
    if (counts == null) {
        return "";
    }
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return [
        plural(counts.features, "feature", "features"),
        plural(counts.fixes, "fix", "fixes"),
        `${counts.other} other`,
    ].join(" · ");
}

export function githubBase(remote: string): string {
    const url = (remote ?? "").replace(/\.git$/, "").replace(/\/+$/, "");
    return /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url) ? url : "";
}

// The pending changes as the ticker reads them, newest first: the ticket and the subject without its type.
export function tickerItems(git: MissionGit, max = TickerMax): TickerItem[] {
    if (git == null) {
        return [];
    }
    const github = githubBase(git.remoteurl);
    // The collector lists the trunk's lead oldest first (git cherry) and what came since a public tag newest first.
    const pending = isSingleBranch(git) ? pendingCommits(git) : [...pendingCommits(git)].reverse();
    return pending.slice(0, max).map((c: RawCommit) => {
        const { ticket, text } = readableSubject(c.subject);
        return {
            key: c.sha,
            ticket,
            text: text || c.subject,
            url: github && ticket ? `${github}/issues/${ticket}` : null,
        };
    });
}

// The header promises "Run CI on develop": the trunk, whatever branch the checkout is on (CI/CD's CI local keeps its
// own run-on-a-branch button).
export function runCiTarget(git: MissionGit, pipeline: PipelineDef, ci: CiState): RunCiTarget {
    const branch = git?.trunk || "";
    const running = ci?.running ? (ci.runs ?? []).find((r) => r.id === ci.running) : null;
    const onTrunk = running != null && running.branch === branch;
    let disabled: string = null;
    if (!branch) {
        disabled = "The project's trunk is not known yet.";
    } else if ((pipeline?.ci?.jobs ?? []).length === 0) {
        disabled = "The pipeline declares no CI job.";
    } else if (ci?.running && !onTrunk) {
        disabled = `A CI run is already on its way${running?.branch ? ` on ${running.branch}` : ""}.`;
    }
    return { branch, running: onTrunk, disabled };
}
