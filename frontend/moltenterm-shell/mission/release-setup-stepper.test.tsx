// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveKey, shippedDictionary } from "../i18n/i18n-core";
import { DetectStep } from "./release-setup-detect";
import {
    kindOfAppType,
    nextLabelKey,
    resumeStep,
    SetupSurvey,
    stepReachable,
    surveyRows,
} from "./release-setup-stepper";

const shipping: SetupSurvey = {
    apptype: "cli",
    apptypeevidence: [{ code: "typeNpmBin", path: "package.json", detail: "saasfoundryai" }],
    kind: "on-premise",
    tags: { read: true, prefix: "v", count: 8, first: "v0.1.0-beta", last: "v1.0.1" },
    releases: { ongithub: true, read: true, count: 2, last: "v1.0.1" },
    publish: [{ file: "publish-stable.yml", tags: ["v[0-9]+.[0-9]+.[0-9]+"], ships: ["npm"] }],
    changelogs: [
        { path: "docs/changelog.md", sections: 12, last: "1.0.1" },
        { path: "docs/fr/changelog.md", sections: 12, last: "1.0.1" },
    ],
    pipeline: "norelease",
    missing: ["rc", "public"],
    ships: true,
    recommended: "analyse",
    base: "h",
};

const empty: SetupSurvey = {
    apptype: "other",
    apptypeevidence: [],
    kind: "on-premise",
    tags: { read: true, prefix: "v", count: 0 },
    releases: { ongithub: false, read: false, count: 0 },
    publish: [],
    changelogs: [],
    pipeline: "none",
    missing: ["rc", "public"],
    ships: false,
    recommended: "describe",
    base: "",
};

describe("pipeline setup stepper frame (FR-MC-038)", () => {
    it("opens a done step, the next one once its inputs exist, never the templates yet", () => {
        expect(stepReachable("detect", "understand", false)).toBe(true);
        expect(stepReachable("prepare", "understand", true)).toBe(true);
        expect(stepReachable("prepare", "understand", false)).toBe(false);
        expect(stepReachable("prepare", "detect", true)).toBe(false);
        expect(stepReachable("template", "prepare", true)).toBe(false);
    });

    it("names the next step in the footer", () => {
        expect(nextLabelKey("detect", "analyse")).toBe("mc.setup.stepper.nextDraw");
        expect(nextLabelKey("detect", "describe")).toBe("mc.setup.stepper.nextDescribe");
        expect(nextLabelKey("understand", "analyse")).toBe("mc.setup.stepper.nextPrepare");
        expect(nextLabelKey("prepare", "analyse")).toBe("");
    });

    it("maps the app type onto the release templates", () => {
        expect(kindOfAppType("web")).toBe("saas");
        for (const type of ["desktop", "cli", "library", "other"] as const) {
            expect(kindOfAppType(type)).toBe("on-premise");
        }
    });

    it("resumes at a saved step it can show, else at step 1", () => {
        expect(resumeStep(null)).toBe("detect");
        expect(resumeStep({ base: "h", step: "understand" })).toBe("understand");
        expect(resumeStep({ base: "h", step: "template" })).toBe("detect");
    });

    it("lists what the repository shows of a pipeline, with keys in both languages", () => {
        const rows = surveyRows(shipping, "origin/develop");
        expect(rows.map((r) => `${r.key}:${r.state}`)).toEqual([
            "tags:ok",
            "releases:ok",
            "publish/publish-stable.yml:ok",
            "changelogs:ok",
            "pipeline:half",
        ]);
        expect(rows[0].source).toBe("git tag · v0.1.0-beta → v1.0.1");
        expect(rows[4].source).toBe(".molten/project.json · origin/develop");
        const all = [...rows, ...surveyRows(empty, ""), ...surveyRows({ ...shipping, pipeline: "complete" }, "")];
        for (const lang of ["en", "fr"]) {
            const dict = shippedDictionary(lang);
            for (const row of all) {
                const key = row.count != null ? `${row.labelKey}.other` : row.labelKey;
                expect(resolveKey(dict, key), `${lang}: ${key}`).toBeTruthy();
            }
        }
    });
});

describe("step 1: detect (FR-MC-038)", () => {
    it("preselects the detected type with its evidence and recommends analysing a shipping project", () => {
        const html = renderToStaticMarkup(
            <DetectStep
                survey={shipping}
                pipelineRef="origin/develop"
                appType="cli"
                path="analyse"
                onType={() => {}}
                onPath={() => {}}
            />
        );
        expect(html).toContain("Command-line tool / npm package");
        expect(html).toContain("Detected");
        expect(html).toContain("npm package saasfoundryai with a command (bin in package.json).");
        expect(html).toContain("8 version tags, the last one v1.0.1");
        expect(html).toContain("2 GitHub releases, the latest v1.0.1");
        expect(html).toContain("publish-stable.yml · tags v[0-9]+.[0-9]+.[0-9]+ · npm");
        expect(html).toContain("2 changelogs with dated sections");
        expect(html).toContain("MoltenTerm pipeline: declared, no release block");
        expect(html).toContain("Yes: this project already ships.");
        expect(html).toMatch(/Analyse the existing pipeline<\/span><\/span><span[^>]*>Recommended/);
        expect(html).toContain("Start from scratch: describe the pipeline I want");
    });

    it("recommends describing a pipeline when nothing ships", () => {
        const html = renderToStaticMarkup(
            <DetectStep
                survey={empty}
                pipelineRef=""
                appType="other"
                path="describe"
                onType={() => {}}
                onPath={() => {}}
            />
        );
        expect(html).toContain("No version tag (vX.Y.Z)");
        expect(html).not.toContain("GitHub release");
        expect(html).toContain("No pipeline found.");
        expect(html).toMatch(/Describe the pipeline I want<\/span><\/span><span[^>]*>Recommended/);
        expect(html).not.toContain("Detected");
    });
});
