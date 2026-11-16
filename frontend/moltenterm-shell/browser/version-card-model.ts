// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The version card of a local tab (FR-BRW-017, DS-BRW-024, #2326): "the version you are looking at", opened from the
// address bar's chip. Where it is (ticket, agent, branch), what to test, the pull request's state in the Integration
// panel's own words and marks, the other versions served now, and their stop. wavesrv finds the servers
// (pkg/molten/mission/servedversions.go); for a project of the workspace this file reads the Integration panel's
// stores through the panel's own functions, so the card never says another thing than the panel. Pure.

import { type Phrase, phrase, wordPhrase } from "../i18n/phrase";
import { cardState, type CardTone } from "../reviews/reviews-card-model";
import type { ReviewMergedPr } from "../reviews/reviews-merged-model";
import { type RebaseAsk, rebaseAskKey, type ReviewPr, type ReviewsAnswer } from "../reviews/reviews-model";
import { type CardContext, cardInputOf } from "../reviews/reviews-sections-model";
import { type AgentBarFacts, branchAgents, draftTurn, type UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import {
    branchText,
    type DetailRow,
    detailRows,
    noPrText,
    reasonText,
    type TestContextAnswer,
    type TestContextPr,
} from "./test-context-model";

// must match ServedVersionsCommand and ServedStopCommand in pkg/molten/mission/servedversions.go
export const ServedVersionsCommand = "moltenmissionservedversions";
export const ServedStopCommand = "moltenmissionservedstop";

// must match ServedServer, ServedVersion and ServedVersions in pkg/molten/mission/servedversions.go
export type ServedServer = { port: number; pid: number; process?: string };

export type ServedVersion = {
    root: string;
    project: string;
    name?: string;
    worktree?: boolean;
    branch?: string;
    sha?: string;
    detached?: boolean;
    dirty?: boolean;
    ticket?: number;
    pr?: TestContextPr;
    futurepr?: boolean;
    projectdir?: string;
    // A project linked to a workspace: the only ones whose servers a stop reaches.
    linked?: boolean;
    servers: ServedServer[];
};

export type ServedVersions = { versions: ServedVersion[]; unknown?: string; at: number };

// must match ServedStopResult in pkg/molten/mission/servedversions.go
export type ServedStopResult = {
    stopped: number[];
    refused?: string;
    folder?: string;
    agent?: string;
    still?: boolean;
};

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// A project of the workspace as the Integration panel reads it (useWorkspaceReviews).
export type ProjectFacts = { dir: string; answer: ReviewsAnswer; ctx: CardContext };

// The pull request's state line: the Integration card's tone and sentence, or, for a project the panel does not read,
// the same words from the cached pull request alone. merged: a check mark instead of a state mark.
export type PrView = {
    number: number;
    title: string;
    url: string;
    tone: CardTone | "merged";
    sentence: string;
    why?: string;
    // Something runs on it and the Integration card shows its dominoes beside the sentence (#1085).
    working?: boolean;
    // The Integration panel can show it: its project is one of the workspace's.
    reviewsDir?: string;
};

// What a test asked of the developer shows: its steps, or that none are written.
export type TestAsk = { steps: string[]; noSteps: boolean };

export type VersionLine = {
    key: string;
    version: ServedVersion;
    // The server the line opens and stops: the tab's own for the current version, the matching one for the others.
    server: ServedServer;
    current: boolean;
    main: boolean;
    branch: string;
    title: string;
    ticket: number;
    agents: string[];
    dirty: boolean;
    // What the panel loads for it.
    url: string;
    // Stop this server is offered: a known server of a project linked to a workspace (any other stop is refused).
    stoppable: boolean;
};

export type VersionCardData = {
    known: boolean;
    reason: string;
    title: string;
    ticket: number;
    agents: string[];
    branch: string;
    dirty: boolean;
    pr: PrView;
    // A ticket branch without a pull request yet, which the Integration panel lists under Upcoming.
    upcoming?: { dir: string; branch: string };
    // Why no pull request shows, "" when one does.
    noPr: string;
    test: TestAsk;
    // What the ticked steps are kept under: the checkout and its pull request.
    stepsKey: string;
    // The project the versions are grouped by (the current version's, or the last one shown).
    projectKey: string;
    projectName: string;
    // The version is of a project the workspace does not link: the Integration panel does not show it.
    otherProject: boolean;
    mine: VersionLine[];
    others: VersionLine[];
    versionsUnknown: boolean;
    details: DetailRow[];
};

export type VersionCardInput = {
    answer: TestContextAnswer;
    served: ServedVersions;
    projects: ProjectFacts[];
    asks: Record<string, RebaseAsk>;
    now: number;
    t: Translate;
};

// The workspace project a version belongs to, as the Integration panel reads it.
function projectOf(projects: ProjectFacts[], dir: string): ProjectFacts {
    return dir ? (projects.find((p) => p.dir === dir) ?? null) : null;
}

function listedPrs(answer: ReviewsAnswer): ReviewPr[] {
    return answer?.state === "ok" ? [...(answer.ready ?? []), ...(answer.drafts ?? [])] : [];
}

// The Integration panel's open PR for the version: its number when wavesrv matched one, else its branch.
export function reviewPrOf(project: ProjectFacts, version: ServedVersion): ReviewPr {
    const prs = listedPrs(project?.answer);
    if (version.pr != null && !version.pr.merged) {
        return prs.find((pr) => pr.number === version.pr.number) ?? null;
    }
    return version.branch ? (prs.find((pr) => pr.branch === version.branch) ?? null) : null;
}

function mergedPrOf(project: ProjectFacts, version: ServedVersion): ReviewMergedPr {
    if (!version.branch) {
        return null;
    }
    const merged = project?.answer?.merged ?? [];
    if (version.pr?.merged) {
        return merged.find((pr) => pr.number === version.pr.number) ?? null;
    }
    return merged.find((pr) => pr.branch === version.branch) ?? null;
}

// The agents on the version's branch, by first name, as the Integration panel places them; a session only passing
// through the worktree does not work on it.
export function agentNames(agents: AgentBarFacts[]): string[] {
    const rtn: string[] = [];
    for (const agent of agents ?? []) {
        const name = (agent.visiting ? "" : agent.name || agent.parentName || "").trim();
        if (name && !rtn.includes(name)) {
            rtn.push(name);
        }
    }
    return rtn;
}

function versionAgents(project: ProjectFacts, version: ServedVersion, pr: ReviewPr): string[] {
    if (project?.ctx == null || !version.branch) {
        return [];
    }
    return agentNames(
        branchAgents(project.ctx.upcoming, project.ctx.states, version.branch, version.ticket, pr?.number ?? 0)
    );
}

// The ticket's title: the Integration panel's (the closing issue's or the branch's ticket), the PR's, an upcoming
// branch's, else none.
function ticketTitle(project: ProjectFacts, version: ServedVersion, pr: ReviewPr, merged: ReviewMergedPr): string {
    if (pr?.tickettitle) {
        return pr.tickettitle;
    }
    const upcoming = project?.ctx?.upcoming?.branches?.find((b) => b.branch === version.branch);
    return pr?.title || merged?.title || version.pr?.title || upcoming?.title || "";
}

// waitsForTest: the version's ticket is in the board's Human Testing column, by the Integration panel's own reading.
export function waitsForTest(upcoming: UpcomingAnswer, branch: string, now: number): boolean {
    if (upcoming == null || !branch) {
        return false;
    }
    const status =
        upcoming.drafts?.find((d) => d.branch === branch)?.status ??
        upcoming.branches?.find((b) => b.branch === branch)?.status;
    if (!status) {
        return false;
    }
    return draftTurn(null, { branch, status }, now, upcoming.humantesting).kind === "test";
}

// testAskOf: what to test, only when a test is asked of the developer: the ticket waits in Human Testing, or the pull
// request is ready for review. A merged PR, or a draft whose ticket is not at the developer's test, asks nothing.
export function testAskOf(pr: TestContextPr, steps: string[], humanTesting: boolean): TestAsk {
    if (pr?.merged) {
        return null;
    }
    const asked = humanTesting || (pr != null && !pr.draft);
    if (!asked) {
        return null;
    }
    const list = (steps ?? []).filter((s) => s.trim() !== "");
    if (list.length > 0) {
        return { steps: list, noSteps: false };
    }
    return humanTesting ? { steps: [], noSteps: true } : null;
}

// prGlance: a PR's state from the cached PR alone (a project the Integration panel does not read), in the panel's
// vocabulary: merged, CI failing, waiting for the CI, draft, ready for review.
export function prGlance(pr: TestContextPr, t: Translate): Pick<PrView, "tone" | "sentence"> {
    if (pr.merged) {
        return { tone: "merged", sentence: t("browser.testContext.state.merged") };
    }
    if (pr.ci === "failure") {
        return { tone: "broken", sentence: t("browser.testContext.state.ciFailing") };
    }
    if (pr.ci === "pending") {
        return { tone: "running", sentence: t("reviews.card.state.ciRunning") };
    }
    if (pr.draft) {
        return { tone: "draft", sentence: t("browser.testContext.state.draft") };
    }
    return { tone: "wait", sentence: t("browser.testContext.state.ready") };
}

// prViewOf: the Integration card's own state for an open PR of a workspace project; a merged one says so; any other
// reads the cached PR.
export function prViewOf(
    version: ServedVersion,
    project: ProjectFacts,
    asks: Record<string, RebaseAsk>,
    t: Translate
): PrView {
    const open = reviewPrOf(project, version);
    if (open != null && project?.ctx != null) {
        const card = cardState(cardInputOf(open, asks?.[rebaseAskKey(project.dir, open.number)], project.ctx));
        return {
            number: open.number,
            title: open.title,
            url: open.url,
            tone: card.tone,
            sentence: wordPhrase(card.sentence),
            why: card.why ? wordPhrase(card.why) : undefined,
            working: card.motion === "state",
            reviewsDir: project.dir,
        };
    }
    const merged = mergedPrOf(project, version);
    if (merged != null) {
        return {
            number: merged.number,
            title: merged.title,
            url: merged.url,
            tone: "merged",
            sentence: t("browser.testContext.state.merged"),
        };
    }
    if (version.pr == null) {
        return null;
    }
    return {
        number: version.pr.number,
        title: version.pr.title,
        url: version.pr.url,
        ...prGlance(version.pr, t),
        // A merged PR is in the panel's Recently merged, not on a card it can mark.
        reviewsDir: project != null && !version.pr.merged ? project.dir : undefined,
    };
}

// The version of the tab's own answer, until wavesrv's list has it: the tab's server is its one server.
export function versionOfAnswer(answer: TestContextAnswer, workspaceDir: string): ServedVersion {
    if (!answer?.known) {
        return null;
    }
    return {
        root: answer.root,
        project: answer.project,
        name: answer.name,
        worktree: answer.worktree,
        branch: answer.branch,
        sha: answer.sha,
        detached: answer.detached,
        dirty: answer.dirty,
        ticket: answer.ticket,
        pr: answer.pr,
        futurepr: answer.futurepr,
        projectdir: answer.sameproject ? workspaceDir : "",
        servers: answer.pid ? [{ port: answer.port, pid: answer.pid, process: answer.process }] : [],
    };
}

// currentVersion: the served version holding the tab's port (wavesrv's list, else the tab's own answer).
export function currentVersion(answer: TestContextAnswer, served: ServedVersions, workspaceDir: string): ServedVersion {
    if (!answer?.known) {
        return null;
    }
    const listed = (served?.versions ?? []).find((v) => (v.servers ?? []).some((s) => s.port === answer.port));
    return listed ?? versionOfAnswer(answer, workspaceDir);
}

// serverFor: the server of another version that stands for the tab's: among its servers run by the same program as
// the tab's (else all of them), the one at the rank the tab's port holds among the current version's.
export function serverFor(version: ServedVersion, here: ServedVersion, port: number): ServedServer {
    const servers = version?.servers ?? [];
    if (servers.length === 0) {
        return null;
    }
    const exact = servers.find((s) => s.port === port);
    if (exact != null && (here == null || version.root === here.root)) {
        return exact;
    }
    const mine = (here?.servers ?? []).find((s) => s.port === port);
    const sameProgram = (list: ServedServer[]) =>
        mine?.process ? list.filter((s) => s.process === mine.process) : list;
    const pool = sameProgram(servers).length > 0 ? sameProgram(servers) : servers;
    const ranked = sameProgram(here?.servers ?? []);
    const rank = Math.max(
        0,
        ranked.findIndex((s) => s.port === port)
    );
    return pool[Math.min(rank, pool.length - 1)];
}

// switchUrl: the tab's address on another port; the same path for a version of the same project, the root of
// another project's app.
export function switchUrl(url: string, port: number, samePath: boolean): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return "";
    }
    parsed.port = String(port);
    if (!samePath) {
        parsed.pathname = "/";
        parsed.search = "";
        parsed.hash = "";
    }
    return parsed.toString();
}

function versionBranch(version: ServedVersion, t: Translate): string {
    return branchText({ branch: version.branch, detached: version.detached, sha: version.sha } as TestContextAnswer, t);
}

function lineOf(version: ServedVersion, input: VersionCardInput, here: ServedVersion, samePath: boolean): VersionLine {
    const { answer, projects, t } = input;
    const project = projectOf(projects, version.projectdir);
    const pr = reviewPrOf(project, version);
    const current = here != null && version.root === here.root;
    const server = current
        ? ((version.servers ?? []).find((s) => s.port === answer.port) ?? serverFor(version, here, answer.port))
        : serverFor(version, here, answer.port);
    return {
        key: version.root,
        version,
        server,
        current,
        main: !version.worktree,
        branch: versionBranch(version, t),
        title: ticketTitle(project, version, pr, mergedPrOf(project, version)),
        ticket: version.ticket ?? 0,
        agents: versionAgents(project, version, pr),
        dirty: !!version.dirty,
        url: server != null ? switchUrl(answer.url, server.port, samePath) : "",
        stoppable: server != null && !!version.linked,
    };
}

// The card's whole content. Versions of the current version's project come first, the current one marked; the
// others go to the folded group. A tab whose server stopped keeps the project it showed (lastProject).
export function versionCardData(input: VersionCardInput, workspaceDir: string, lastProject?: string): VersionCardData {
    const { answer, served, projects, asks, now, t } = input;
    const here = currentVersion(answer, served, workspaceDir);
    const project = projectOf(projects, here?.projectdir);
    const pr = here != null ? prViewOf(here, project, asks, t) : null;
    const openPr = here != null ? reviewPrOf(project, here) : null;
    const humanTesting = here != null && waitsForTest(project?.ctx?.upcoming, here.branch, now);
    const projectKey = here?.project ?? lastProject ?? "";
    const mine: VersionLine[] = [];
    const others: VersionLine[] = [];
    for (const version of served?.versions ?? []) {
        if (projectKey && version.project === projectKey) {
            mine.push(lineOf(version, input, here, true));
        } else {
            others.push(lineOf(version, input, here, false));
        }
    }
    if (here != null && !mine.some((line) => line.current)) {
        mine.unshift(lineOf(here, input, here, true));
    }
    const mergedPr = here != null ? mergedPrOf(project, here) : null;
    // Draft or merged as the Integration panel last read it, else as the collector's cache has it.
    const prFacts: TestContextPr =
        openPr != null
            ? { number: openPr.number, title: openPr.title, url: openPr.url, draft: openPr.draft }
            : mergedPr != null
              ? { number: mergedPr.number, title: mergedPr.title, url: mergedPr.url, merged: true }
              : (here?.pr ?? null);
    const upcoming =
        here != null && project != null && pr == null && here.futurepr && (here.ticket ?? 0) > 0
            ? { dir: project.dir, branch: here.branch }
            : undefined;
    return {
        known: !!answer?.known,
        reason: answer?.known ? "" : reasonText(answer, t),
        title: here != null ? ticketTitle(project, here, openPr, mergedPr) : "",
        ticket: here?.ticket ?? 0,
        agents: here != null ? versionAgents(project, here, openPr) : [],
        branch: here != null ? versionBranch(here, t) : "",
        dirty: !!here?.dirty,
        pr,
        upcoming,
        noPr: here != null && pr == null ? noPrText(answer, t) : "",
        test: here != null ? testAskOf(prFacts, answer?.steps, humanTesting) : null,
        stepsKey: here != null ? `${here.root}#${prFacts?.number ?? 0}` : "",
        projectKey,
        projectName: here?.name || "",
        otherProject: here != null && !here.projectdir,
        mine,
        others,
        versionsUnknown: served?.unknown === "unreadable",
        details: answer != null ? detailRows(answer, t) : [],
    };
}

const RefusalKeys: Record<string, string> = {
    gone: "browser.testContext.stop.refused.gone",
    moved: "browser.testContext.stop.refused.moved",
    norepo: "browser.testContext.stop.refused.norepo",
    unknownproject: "browser.testContext.stop.refused.unknownProject",
    self: "browser.testContext.stop.refused.self",
    agent: "browser.testContext.stop.refused.agent",
    unknown: "browser.testContext.stop.refused.unknown",
};

// What a stop did: stopped (the shown version: pick another one), refused and why, or served again at once.
export function stopOutcomePhrase(result: ServedStopResult, line: VersionLine): Phrase {
    const vars = {
        branch: line.branch,
        port: line.server?.port ?? 0,
        folder: result.folder ?? "",
        agent: result.agent ?? "",
    };
    if (result.refused) {
        return phrase(RefusalKeys[result.refused] ?? "browser.testContext.stop.refused.other", vars);
    }
    if (result.still) {
        return phrase("browser.testContext.stop.still", vars);
    }
    return phrase(line.current ? "browser.testContext.stop.doneCurrent" : "browser.testContext.stop.done", vars);
}
