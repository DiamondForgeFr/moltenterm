// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CiState } from "../mission/ci-model";
import { PipelineDef, RunRecord } from "../mission/mission-model";
import { ReleaseFacts, releaseRun } from "../mission/release-run";
import { ReleaseFollow } from "../mission/release-run-panel";
import { NowCard, StepsHint } from "./overview-cards";
import { ProjectCardProps } from "./project-context";
import { RunningBand } from "./running-band";
import { RunningBandView } from "./running-band-view";

const Started = Date.now() - 3 * 60_000;

function build(extra: Partial<RunRecord> = {}): RunRecord {
    return {
        id: "b1",
        dir: "/p",
        kind: "build",
        stepid: "gold",
        title: "Gold",
        command: "task gold",
        startedat: Started,
        state: "running",
        phases: ["prepare", "frontend", "wavesrv"],
        phaseat: [Started, Started + 20_000, Started + 120_000],
        commit: "9b79731abcdef",
        logsize: 0,
        ...extra,
    };
}

const earlier = build({
    id: "b0",
    state: "success",
    startedat: Started - 3_600_000,
    finishedat: Started - 3_600_000 + 300_000,
    phases: ["prepare", "frontend", "wavesrv", "package", "install"],
    phaseat: [0, 20_000, 120_000, 220_000, 280_000].map((ms) => Started - 3_600_000 + ms),
});

const pipeline = {
    builds: [
        {
            id: "gold",
            title: "Gold",
            run: "task gold",
            phases: [
                { id: "prepare", title: "Prepare" },
                { id: "frontend", title: "Frontend" },
                { id: "wavesrv", title: "Wavesrv" },
                { id: "package", title: "Package" },
                { id: "install", title: "Install" },
            ],
        },
    ],
    steps: [],
} as unknown as PipelineDef;

const facts: ReleaseFacts = {
    tag: "v1.0.0-12",
    version: "1.0.0-12",
    channel: "rc",
    tagexists: true,
    steps: {},
    runs: [
        {
            databaseId: 1,
            workflowName: "release",
            headBranch: "v1.0.0-12",
            status: "in_progress",
            conclusion: "",
            url: "https://example.test/actions/runs/1",
            createdAt: "2026-11-10T10:00:00Z",
        },
    ],
    jobs: [
        { name: "a", status: "completed", conclusion: "success", startedAt: "", completedAt: "", url: "" },
        { name: "b", status: "in_progress", conclusion: "", startedAt: "", completedAt: "", url: "" },
    ],
    ontrunk: false,
};

function follow(over: Partial<ReleaseFollow> = {}): ReleaseFollow {
    const run = releaseRun(facts, []);
    return {
        run,
        jobs: facts.jobs,
        actions: { run: async () => true, loadNotes: async () => "", saveNotes: async () => {} },
        lock: { pending: "", run: async () => false },
        awaits: undefined,
        startedat: Started - 60_000,
        abandon: async () => {},
        error: null,
        prompt: null,
        ...over,
    };
}

function props(over: Partial<ProjectCardProps> = {}): ProjectCardProps {
    return {
        project: { workspace: { oid: "w1" } as Workspace, dir: "/p", facts: null },
        projectName: "Synthetic",
        snapshot: { git: { trunk: "develop" } } as any,
        refresh: () => {},
        pipeline,
        runs: [],
        ci: { runs: [], branches: [] } as CiState,
        reloadCi: () => {},
        release: null,
        reloadRelease: () => {},
        releaseFollow: follow({ run: null }),
        startBuild: async () => "",
        startStep: () => {},
        runCi: () => {},
        showRuns: () => {},
        group: null,
        ...over,
    };
}

// The band's rows are the lazy view: the card around it only decides whether the band is there.
function render(p: ProjectCardProps): string {
    return renderToStaticMarkup(<RunningBandView {...p} />);
}

// The opening tag of the element with this test id.
function tagOf(html: string, testId: string): string {
    const at = html.indexOf(`data-testid="${testId}"`);
    expect(at, testId).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

describe("the In progress band (AC-1, #2188)", () => {
    it("is not drawn when nothing runs", () => {
        expect(render(props())).toBe("");
        expect(render(props({ runs: [build({ state: "success", finishedat: Started + 1000 })] }))).toBe("");
        expect(render(props({ runs: [build({ state: "cancelled", finishedat: Started + 1000 })] }))).toBe("");
        expect(render(props({ runs: [build({ state: "failure", closed: true })] }))).toBe("");
    });

    it("loads its rows only when something runs: the card around them draws nothing and loads nothing otherwise", () => {
        const card = (p: ProjectCardProps) => renderToStaticMarkup(<RunningBand {...p} />);
        expect(card(props())).toBe("");
        expect(card(props({ runs: [build({ state: "success", finishedat: Started + 1000 })] }))).toBe("");
        expect(card(props({ runs: [build({ state: "failure", closed: true })] }))).toBe("");
        const source = readFileSync(new URL("./running-band.tsx", import.meta.url), "utf8");
        expect(source).toMatch(/lazy\(\(\) => import\("\.\/running-band-view"\)/);
        expect(source).not.toMatch(/from "\.\/running-band-view"/);
        for (const eager of ["build-run-row", "release-run-row", "run-row"]) {
            expect(source, eager).not.toContain(`mission/${eager}"`);
        }
    });

    it("holds one row per run under one border, and no frame inside a row", () => {
        const html = render(props({ runs: [build(), earlier], releaseFollow: follow() }));
        expect(html).toContain('aria-label="In progress"');
        expect(tagOf(html, "project-band-count")).toBeTruthy();
        expect(html.match(/data-testid="project-band-count"[^>]*>(\d+)</)?.[1]).toBe("2");
        const band = tagOf(html, "project-band");
        expect(band).toContain("border");
        expect(band).toContain("rounded-6");
        for (const row of ["build-run", "release-run"]) {
            const tag = tagOf(html, row);
            expect(tag).not.toMatch(/\bborder\b|bg-gradient|rounded-6/);
            expect(tag).toContain('data-kind="');
        }
        expect(html).not.toContain("bg-gradient");
        expect(html.match(/rounded-6 border/g)).toHaveLength(1);
    });

    it("lists the CI of a branch and a running step as rows too", () => {
        const ci: CiState = {
            runs: [
                {
                    id: "c1",
                    dir: "/p",
                    sha: "s",
                    tree: "t",
                    branch: "feature/2",
                    startedat: Started,
                    status: "running",
                    jobs: [{ name: "lint", status: "success" }],
                },
            ],
            running: "c1",
            branches: [],
        };
        const html = render(props({ ci }));
        expect(html).toContain("CI on feature/2");
        expect(html).toContain('data-testid="project-work"');
    });
});

// The entry bundle is budgeted (scripts/perf): what only the band uses stays out of it. The row modules are imported by
// the band's own files alone, which running-band.tsx imports lazily.
describe("the band's code stays out of the entry bundle (#2188)", () => {
    const shell = fileURLToPath(new URL("..", import.meta.url));
    const sources = (readdirSync(shell, { recursive: true }) as string[])
        .map((f) => f.split("\\").join("/"))
        .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
    const importers = (module: RegExp) =>
        sources.filter((f) => module.test(readFileSync(join(shell, f), "utf8"))).sort();

    it("is imported by the lazy view and its rows only", () => {
        expect(importers(/from "(?:\.\.\/mission|\.)\/run-row"/)).toEqual([
            "mission/build-run-row.tsx",
            "mission/release-run-row.tsx",
            "project/running-band-view.tsx",
        ]);
        expect(importers(/from "(?:\.\.\/mission|\.)\/run-row-model"/)).toEqual([
            "mission/build-run-row.tsx",
            "mission/release-run-row.tsx",
            "mission/run-row.tsx",
            "project/running-band-view.tsx",
        ]);
        expect(importers(/from "(?:\.\.\/mission|\.)\/(?:build|release)-run-row"/)).toEqual([
            "project/running-band-view.tsx",
        ]);
    });
});

describe("the build's row (AC-2, AC-3)", () => {
    it("shows its name and place, its phases with the current one's progress, the time and its actions", () => {
        const now = Started + 120_000 + 62_000;
        const html = render(props({ runs: [build(), earlier] }));
        expect(html).toContain("Gold");
        expect(html).toContain("local build · develop @ 9b79731");
        for (const phase of ["Prepare", "Frontend", "Wavesrv", "Package", "Install"]) {
            expect(html).toContain(phase);
        }
        expect(html).toMatch(/Wavesrv · \d+%/);
        expect(html).toContain("/ ~5 min");
        expect(now).toBeGreaterThan(Started);
        expect(tagOf(html, "build-run")).toContain('data-tone="working"');
        expect(tagOf(html, "build-run-cancel")).toBeTruthy();
        expect(tagOf(html, "run-row-log-toggle")).toContain('aria-expanded="false"');
        expect(html).not.toContain('data-testid="build-run-retry"');
        expect(html).not.toContain('data-testid="build-run-close"');
    });

    it("keeps the log closed while it runs and unfolds it under the row without a frame", () => {
        const html = render(props({ runs: [build()] }));
        expect(html).not.toContain('data-testid="build-run-log"');
    });

    it("keeps a failed build's row in the failure colour, with Retry, Close and its log open", () => {
        const html = render(props({ runs: [build({ state: "failure", finishedat: Started + 5000 })] }));
        const row = tagOf(html, "build-run");
        expect(row).toContain('data-tone="failed"');
        expect(tagOf(html, "run-row-log-toggle")).toContain('aria-expanded="true"');
        const log = tagOf(html, "build-run-log");
        expect(log).not.toMatch(/\bborder\b|rounded/);
        expect(html).toContain("Retry");
        expect(tagOf(html, "build-run-retry")).toContain("molten-btn");
        expect(tagOf(html, "build-run-close")).toBeTruthy();
        expect(html).not.toContain('data-testid="build-run-cancel"');
        expect(html).toContain("Failed during");
        expect(tagOf(html, "run-row-time")).toBeTruthy();
        expect(html.match(/data-testid="run-row-time"[^>]*>([^<]*)</)?.[1]).toBe("5 s");
        expect(html).toContain("Whole log");
        expect(html).toContain("Copy");
    });
});

describe("the release's row (AC-2, AC-6)", () => {
    it("shows the release, its five phases with the build's jobs, and its buttons", () => {
        const html = render(props({ releaseFollow: follow() }));
        expect(html).toContain("Release v1.0.0-12");
        expect(html).toContain("release candidate · tag pushed");
        expect(html).toMatch(/Build · 1\/2/);
        for (const phase of ["Prepare", "Cut", "Publish", "Back"]) {
            expect(html).toContain(phase);
        }
        expect(tagOf(html, "release-run")).toContain('data-tone="working"');
        expect(tagOf(html, "release-run-phase-build")).toContain('aria-current="step"');
        expect(html).toContain("See on GitHub");
        expect(tagOf(html, "release-run-details")).toContain('aria-expanded="false"');
        expect(tagOf(html, "release-run-abandon")).toBeTruthy();
    });

    it("unfolds by itself what waits for the developer, with the action of the phase", () => {
        const waiting = releaseRun({ ...facts, tagexists: false, runs: [], jobs: [] }, [
            { id: "cut", title: "Cut", run: "molten release cut", phase: "cut" } as any,
        ]);
        const html = render(props({ releaseFollow: follow({ run: waiting, jobs: [] }) }));
        expect(tagOf(html, "release-run")).toContain('data-tone="waiting"');
        expect(tagOf(html, "release-run-details")).toContain('aria-expanded="true"');
        expect(html).toContain('data-testid="release-run-detail-');
        expect(html).toContain('data-testid="release-run-action"');
    });
});

describe("the Now card, flat (AC-1, AC-4)", () => {
    const now = (p: ProjectCardProps) => renderToStaticMarkup(<NowCard {...p} />);

    it("says a run in the band is running, see above, and holds no block of its own", () => {
        const html = now(props({ runs: [build(), earlier], releaseFollow: follow() }));
        expect(html.match(/running, see above/g)).toHaveLength(2);
        for (const gone of ["build-run", "release-run", "bg-gradient", "rounded-6 border", "border-yellow"]) {
            expect(html, gone).not.toContain(gone);
        }
        expect(html).toContain("Gold");
        expect(html).toContain("Release v1.0.0-12");
    });

    it("lists the finished build and the last release on one line each, with Rebuild", () => {
        const done = build({ state: "success", startedat: Started - 700_000, finishedat: Started - 660_000 });
        const html = now(props({ runs: [done], releaseFollow: follow({ run: null }) }));
        expect(html).toContain("succeeded");
        expect(html).toContain('data-testid="project-now-build-rebuild"');
        expect(html).not.toContain("see above");
        expect(html).not.toContain("build-run");
    });
});

describe("the Project steps card, collapsed (AC-5)", () => {
    it("gives one discreet line with Add steps when the pipeline declares no overview step", () => {
        const html = renderToStaticMarkup(<StepsHint {...props()} />);
        expect(html).toContain('data-testid="project-steps-hint"');
        expect(html).toContain("Add steps");
        expect(html).toContain("once there are some");
    });

    it("leaves the line out once the pipeline declares a step for the overview", () => {
        const withSteps = {
            ...pipeline,
            steps: [{ id: "lint", section: "timeline", run: "x" }],
        } as unknown as PipelineDef;
        expect(renderToStaticMarkup(<StepsHint {...props({ pipeline: withSteps })} />)).toBe("");
    });

    it("says the steps come with the pipeline when none is connected, without a button", () => {
        const html = renderToStaticMarkup(<StepsHint {...props({ pipeline: null })} />);
        expect(html).toContain("once the pipeline is connected");
        expect(html).not.toContain("Add steps");
    });
});
