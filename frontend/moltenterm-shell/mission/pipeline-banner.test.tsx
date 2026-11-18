// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A pipeline file holding fields written for a newer MoltenTerm (#2370): the problems box names them, and the pipeline
// stays valid, so its actions stay shown.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PipelineBanner } from "./mission-frame";
import { PipelineReport, pipelineStage } from "./mission-model";

const report: PipelineReport = {
    path: "/p/.molten/project.json",
    present: true,
    valid: true,
    errors: [],
    warnings: ['release: unknown field "preflight" ignored: it needs a newer MoltenTerm'],
    unknown: ["release.preflight"],
    pipeline: { schema: 1, name: "p", release: { rc: [{ id: "cut", title: "Cut", run: "true" }] } } as any,
};

describe("unknown pipeline fields (#2370)", () => {
    it("shows them in the problems box while the pipeline stays valid", () => {
        const html = renderToStaticMarkup(<PipelineBanner dir="/p" report={report} />);
        expect(html).toContain('data-testid="pipeline-newer-fields"');
        expect(html).toContain("The pipeline has problems");
        expect(html).toContain("These fields need a newer MoltenTerm");
        expect(html).toContain("release.preflight");
        expect(html).not.toContain("/molten-pipeline");
        expect(pipelineStage(report)).toBe("valid");
    });

    it("shows nothing for a valid pipeline without unknown fields", () => {
        const html = renderToStaticMarkup(<PipelineBanner dir="/p" report={{ ...report, unknown: undefined }} />);
        expect(html).toBe("");
    });
});
