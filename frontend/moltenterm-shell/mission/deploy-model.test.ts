// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { deployRevision, deployTargets, isProductionLike, revisionText, stepRunning } from "./deploy-model";
import { MissionGit, PipelineDef, RunRecord } from "./mission-model";

function pipeline(steps: PipelineDef["steps"]): PipelineDef {
    return { schema: 1, name: "x", steps };
}

function run(stepid: string, state: RunRecord["state"], startedat: number): RunRecord {
    return {
        id: `${stepid}-${startedat}`,
        dir: "/p",
        kind: "step",
        stepid,
        command: "true",
        startedat,
        state,
        phases: [],
        logsize: 0,
    };
}

describe("deploy targets (#559)", () => {
    it("lists only the cd steps naming an environment, in declared order, with their last run", () => {
        const targets = deployTargets(
            pipeline([
                { id: "verify", title: "Verify", section: "cd", run: "true" },
                { id: "deploy-dev", title: "Deploy to ofpis-dev", section: "cd", environment: "dev", run: "true" },
                { id: "lint", title: "Lint", section: "cilocal", environment: "dev", run: "true" },
                { id: "deploy-prod", title: "Deploy to prod", section: "cd", environment: "prod", run: "true" },
            ]),
            [run("deploy-dev", "success", 20), run("deploy-dev", "failure", 10)]
        );
        expect(targets.map((t) => [t.environment, t.stepId, t.title, t.confirm, t.last?.state ?? null])).toEqual([
            ["dev", "deploy-dev", "Deploy to ofpis-dev", false, "success"],
            ["prod", "deploy-prod", "Deploy to prod", true, null],
        ]);
    });

    it("shows nothing without an environment, or without a pipeline", () => {
        expect(deployTargets(pipeline([{ id: "verify", title: "Verify", section: "cd", run: "true" }]), [])).toEqual(
            []
        );
        expect(deployTargets(null, [])).toEqual([]);
    });

    it("asks first for a production-like name or confirm: true", () => {
        for (const name of ["prod", "production", "live", "PROD", "prod-eu", "eu_production", "live.site"]) {
            expect(isProductionLike(name), name).toBe(true);
        }
        for (const name of ["dev", "staging", "preprod", "products", "deliver", ""]) {
            expect(isProductionLike(name), name).toBe(false);
        }
        const [staging] = deployTargets(
            pipeline([{ id: "s", title: "S", section: "cd", environment: "staging", confirm: true, run: "true" }]),
            []
        );
        expect(staging.confirm).toBe(true);
    });

    it("names the branch checked out and its commit", () => {
        const git = {
            current: "develop",
            branches: [{ name: "develop", sha: "abcdef1234567", date: "", commits: [], fork: null }],
        } as MissionGit;
        expect(revisionText(deployRevision(git))).toBe("develop at abcdef1");
        expect(revisionText(deployRevision({ ...git, current: "feature/x" }))).toBe("feature/x");
        expect(revisionText(deployRevision({ ...git, current: "" }))).toMatch(/no branch/);
    });

    it("holds the deploys while any step runs", () => {
        expect(stepRunning([run("other", "running", 1)])).toBe(true);
        expect(stepRunning([run("other", "success", 1)])).toBe(false);
    });
});
