// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentStateInfo } from "../agent-state-model";
import { CiState } from "../mission/ci-model";
import { PullRequest } from "../mission/github";
import { MissionBranch, MissionGit, RunRecord } from "../mission/mission-model";
import { layoutProjectCards, ProjectCard, ProjectCardRegistry } from "./project-cards";
import {
    checkProjectRoute,
    checkProjectSource,
    checkWebUrl,
    projectBranchRows,
    projectWork,
    workspaceAgents,
} from "./project-model";

function branch(name: string, date: string, ahead: number): MissionBranch {
    return {
        name,
        sha: `${name}-sha`,
        date,
        commits: Array.from({ length: ahead }, (_, i) => ({ sha: `${name}${i}`, subject: "feat: x", date }) as any),
        fork: null,
    };
}

function git(branches: MissionBranch[], extra: Partial<MissionGit> = {}): MissionGit {
    return {
        trunk: "develop",
        release: "main",
        current: "feature/2",
        branches,
        tags: [],
        ahead: [],
        sincepublic: [],
        ...extra,
    };
}

function pr(head: string, extra: Partial<PullRequest> = {}): PullRequest {
    return {
        number: 7,
        title: "A change",
        headRefName: head,
        baseRefName: "develop",
        isDraft: false,
        createdAt: "",
        updatedAt: "",
        url: "https://github.com/o/r/pull/7",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
            { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
            { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
            { name: "build", status: "IN_PROGRESS" },
        ],
        ...extra,
    };
}

describe("projectBranchRows", () => {
    it("keeps the trunk, the release branch and the branches with work or a pull request, newest first", () => {
        const g = git([
            branch("main", "2026-10-01T10:00:00Z", 0),
            branch("develop", "2026-10-03T10:00:00Z", 0),
            branch("feature/1", "2026-10-02T10:00:00Z", 3),
            branch("feature/2", "2026-10-03T12:00:00Z", 1),
            branch("fix/merged", "2026-10-03T13:00:00Z", 0),
            branch("fix/pr-only", "2026-09-30T10:00:00Z", 0),
        ]);
        const ci: CiState["branches"] = [
            { name: "feature/2", sha: "x", date: 0, verdict: "failure" },
            { name: "develop", sha: "y", date: 0, verdict: "success" },
        ];
        const { rows, merged } = projectBranchRows(g, ci, [pr("fix/pr-only")]);
        expect(rows.map((r) => r.name)).toEqual(["develop", "main", "feature/2", "feature/1", "fix/pr-only"]);
        expect(merged).toBe(1);
        expect(rows[0]).toMatchObject({ role: "trunk", ahead: null, ci: "success", pr: null });
        expect(rows[1]).toMatchObject({ role: "release", ci: null });
        expect(rows[2]).toMatchObject({ role: "feature", ahead: 1, current: true, ci: "failure" });
        expect(rows[4].pr).toMatchObject({
            number: 7,
            draft: false,
            merge: { label: "ready to merge", tone: "success" },
            checks: { passed: 1, failed: 1, pending: 1 },
        });
    });

    it("shows a single-branch project once and says when a pull request is a draft", () => {
        const g = git([branch("main", "2026-10-01T10:00:00Z", 0), branch("wip", "2026-10-02T10:00:00Z", 2)], {
            trunk: "main",
            release: "main",
            current: "main",
        });
        const { rows } = projectBranchRows(g, [], [pr("wip", { isDraft: true })]);
        expect(rows.map((r) => r.name)).toEqual(["main", "wip"]);
        expect(rows[1].pr.merge).toEqual({ label: "draft", tone: "neutral" });
        expect(projectBranchRows(g, [], [], "wip").rows.map((r) => r.current)).toEqual([false, true]);
    });

    it("has no rows before git answers", () => {
        expect(projectBranchRows(null, [], [])).toEqual({ rows: [], merged: 0 });
    });
});

describe("workspaceAgents", () => {
    it("keeps the workspace's agents, most urgent first, then the longest running", () => {
        const states: Record<string, AgentStateInfo> = {
            a: { blockid: "a", workspaceid: "w", state: "working", since: 20, version: 1 },
            b: { blockid: "b", workspaceid: "w", state: "waiting", since: 30, version: 1 },
            c: { blockid: "c", workspaceid: "other", state: "waiting", version: 1 },
            d: { blockid: "d", workspaceid: "w", state: "working", since: 10, version: 1 },
            e: { blockid: "e", workspaceid: "w", state: "done", since: 5, version: 1 },
        };
        expect(workspaceAgents(states, "w").map((s) => s.blockid)).toEqual(["b", "d", "a", "e"]);
    });
});

describe("projectWork", () => {
    it("lists the CI run, the running builds and steps, and the release on its way", () => {
        const ci: CiState = {
            runs: [
                {
                    id: "c1",
                    dir: "/p",
                    sha: "s",
                    tree: "t",
                    branch: "feature/2",
                    startedat: 100,
                    status: "running",
                    jobs: [
                        { name: "lint", status: "success" },
                        { name: "test", status: "running" },
                    ],
                },
            ],
            running: "c1",
            branches: [],
        };
        const runs = [
            {
                id: "b1",
                kind: "build",
                stepid: "gold",
                title: "Gold",
                state: "running",
                startedat: 50,
                phases: ["compile"],
            },
            { id: "b0", kind: "build", stepid: "gold", title: "Gold", state: "success", startedat: 10, phases: [] },
            { id: "s1", kind: "step", stepid: "deploy", title: "Deploy", state: "running", startedat: 60, phases: [] },
        ] as RunRecord[];
        const work = projectWork(ci, runs, { tag: "v1.2.0-rc.1", version: "1.2.0", channel: "rc", startedat: 70 });
        expect(work.map((w) => [w.kind, w.label, w.detail])).toEqual([
            ["ci", "CI on feature/2", "1/2 jobs"],
            ["build", "Build Gold", "compile"],
            ["step", "Deploy", ""],
            ["release", "Release v1.2.0-rc.1", "candidate"],
        ]);
        expect(projectWork(null, [], null)).toEqual([]);
    });
});

describe("notification routing", () => {
    it("routes build, CI and release notifications that open a Mission Control panel", () => {
        expect(checkProjectRoute("build", "molten-timeline")).toBe(true);
        expect(checkProjectRoute("ci", "molten-cicd")).toBe(true);
        expect(checkProjectRoute("agent", "molten-timeline")).toBe(false);
        expect(checkProjectRoute("build", "term")).toBe(false);
        expect(checkProjectSource({ source: "build" })).toBe(true);
        expect(checkProjectSource({ source: "build", blockid: "b" })).toBe(false);
        expect(checkProjectSource({ source: "agent" })).toBe(false);
    });

    it("opens only web pages from a pull request's address", () => {
        expect(checkWebUrl("https://github.com/o/r/pull/7")).toBe(true);
        expect(checkWebUrl("file:///etc/passwd")).toBe(false);
        expect(checkWebUrl("vscode://x")).toBe(false);
        expect(checkWebUrl("")).toBe(false);
    });
});

describe("project cards", () => {
    const Nothing = () => null as any;
    const card = (id: string, region: ProjectCard["region"], order: number): ProjectCard => ({
        id,
        title: id,
        region,
        order,
        component: Nothing,
    });

    it("lays the cards out by region and order, ties in registration order", () => {
        const layout = layoutProjectCards([
            card("b2", "band", 20),
            card("m", "main", 10),
            card("b1", "band", 10),
            card("b3", "band", 20),
            card("s", "side", 0),
            { ...card("x", "main", 0), region: "nowhere" as any },
        ]);
        expect(layout.band.map((c) => c.id)).toEqual(["b1", "b2", "b3"]);
        expect(layout.main.map((c) => c.id)).toEqual(["m"]);
        expect(layout.side.map((c) => c.id)).toEqual(["s"]);
    });

    it("replaces a card registered again under its id, and removes it on unregister", () => {
        const registry = new ProjectCardRegistry();
        let changes = 0;
        registry.subscribe(() => changes++);
        registry.register(card("a", "band", 10));
        const override = card("a", "main", 5);
        const unregister = registry.register(override);
        expect(registry.cards).toEqual([override]);
        unregister();
        unregister();
        expect(registry.cards).toEqual([]);
        expect(changes).toBe(3);
    });
});
