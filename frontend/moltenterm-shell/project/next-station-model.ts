// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the Project overview's header band shows (FR-MC-021, DS-MC-012, DS-MC-013): the next station, what waits on
// the trunk, the ticker of those changes and the trunk the Run CI button runs on. Computed from what the core already
// hands every card (no new git or GitHub call), and kept apart from the component so it can be tested without the app.

import { CiState } from "../mission/ci-model";
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

// The release state the line map's terminus reads (buildLineMap in ../mission/line-map-model.ts), from the same
// inputs, so the header and the map name the same next version in the same state.
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

function githubBase(remote: string): string {
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

// The ticker's length in seconds: a steady reading speed, whatever the number of changes.
export function tickerDuration(items: readonly TickerItem[]): number {
    const chars = (items ?? []).reduce((sum, i) => sum + (i.ticket?.length ?? 0) + i.text.length + 6, 0);
    return Math.max(20, Math.round(chars / 7));
}
