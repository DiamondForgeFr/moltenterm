// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { OnboardingAgent } from "./onboarding-agent-model";
import { pipelineCall, projectCandidates, projectColour, WorkspaceColours } from "./onboarding-project-model";

function agent(id: string, invocation: string): OnboardingAgent {
    return {
        id,
        name: id,
        path: "/p",
        invocation: invocation.replace("{name}", "morph"),
        format: "skill",
        installed: true,
        found: true,
        guides: [
            {
                name: "molten-pipeline",
                path: "/p",
                invocation: invocation.replace("{name}", "molten-pipeline"),
                installed: true,
            },
        ],
    };
}

describe("your project step (FR-ONB-004)", () => {
    it("proposes the recent folders first, then the repositories found, each once", () => {
        const got = projectCandidates(
            ["/home/u/app/", "/home/u/site"],
            [
                { path: "/home/u/app", name: "app", modtime: 3 },
                { path: "/home/u/code/api", name: "api", modtime: 2 },
            ]
        );
        expect(got.map((c) => [c.path, c.name, !!c.recent])).toEqual([
            ["/home/u/app", "app", true],
            ["/home/u/site", "site", true],
            ["/home/u/code/api", "api", false],
        ]);
        expect(projectCandidates(null, null)).toEqual([]);
        expect(projectCandidates(["/a", "/b", "/c"], [], 2)).toHaveLength(2);
    });

    it("gives a project the same colour from wavesrv's palette every time", () => {
        expect(WorkspaceColours).toContain(projectColour("moltenterm"));
        expect(projectColour("moltenterm")).toBe(projectColour("moltenterm"));
        expect(WorkspaceColours).toContain(projectColour(""));
    });

    it("writes /molten-pipeline in the chosen agent's syntax, else the generic sentence", () => {
        expect(pipelineCall(agent("codex", "${name} <request>"), null)).toBe("$molten-pipeline");
        expect(pipelineCall(agent("kimi", "/skill:{name} <request>"), null)).toBe("/skill:molten-pipeline");
        const generic = agent("generic", "Read /d/{name}.md and follow it with my request: <request>");
        expect(pipelineCall(null, generic)).toBe(
            "Read /d/molten-pipeline.md and follow it with my request: connect this project to Mission Control"
        );
        expect(pipelineCall(null, null)).toBe("/molten-pipeline");
    });
});
