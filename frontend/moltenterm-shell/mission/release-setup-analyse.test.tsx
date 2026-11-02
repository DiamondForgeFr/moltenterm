// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2a (FR-MC-040, TC-MC-049): the existing pipeline of a SaaSFoundryAI-shaped repository, read into points and
// drawn; the answers reach the draft's options.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { resolveKey, shippedDictionary } from "../i18n/i18n-core";
import { AnalyseStep } from "./release-setup-analyse";
import {
    analysePipeline,
    AnalysisPoint,
    existingFlowModel,
    optionsOfAnswers,
    pendingPoints,
} from "./release-setup-analyse-model";
import { FlowDiagram } from "./release-setup-diagram";
import type { SetupDraft, SetupOptions } from "./release-setup-model";
import type { SetupSurvey } from "./release-setup-stepper";

const defaults: SetupOptions = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "rcpr",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: ["docs/changelog.md", "docs/fr/changelog.md"],
    ciworkflows: [],
    dispatch: [{ workflow: "deploy-docs.yml", channel: "public" }],
    notes: false,
    notespath: "releases/{tag}.md",
    syncback: true,
    milestone: true,
    manual: [],
    environments: [],
    reconcile: true,
    labels: [{ path: "AGENTS.md", line: 177, pattern: "" }],
};

const survey: SetupSurvey = {
    apptype: "cli",
    apptypeevidence: [],
    kind: "on-premise",
    tags: {
        read: true,
        prefix: "v",
        count: 8,
        first: "v0.1.0-beta",
        last: "v1.0.1",
        pre: 3,
        lastpublic: "v1.0.1",
        lastmerge: true,
    },
    releases: { ongithub: true, read: true, count: 2, last: "v1.0.1" },
    publish: [],
    changelogs: [],
    pipeline: "norelease",
    missing: ["rc", "public"],
    ships: true,
    recommended: "analyse",
    base: "h",
};

const draft: SetupDraft = {
    provider: "moltenterm",
    warnings: [],
    facts: {
        name: "SaaSFoundryAI",
        haspipeline: true,
        missing: ["rc", "public"],
        branches: {
            trunk: "develop",
            release: "master",
            trunkfrom: ".saasfoundry.json workflow.workingBranch",
            releasefrom: ".saasfoundry.json workflow.releaseBranch",
        },
        rcbranchpattern: "rc-{version}",
        tagprefix: "v",
        versionsdeclared: true,
        versionsource: { code: "versionsDeclared", path: ".molten/project.json" },
        notesdeclared: false,
        notespath: "releases/{tag}.md",
        notesfound: true,
        changelogs: [
            { path: "docs/changelog.md", lang: "en" },
            { path: "docs/fr/changelog.md", lang: "fr" },
        ],
        workflows: [
            { file: "test.yml", name: "Tests", push: true, pullrequest: true, dispatch: false, role: "ci" },
            {
                file: "publish-stable.yml",
                push: true,
                tags: ["v[0-9]+.[0-9]+.[0-9]+"],
                dispatch: false,
                environments: ["npm-production"],
                role: "publish",
                ships: ["npm", "githubrelease"],
            },
            {
                file: "deploy-docs.yml",
                name: "Deploy Documentation",
                push: false,
                dispatch: true,
                role: "docs",
                ships: ["pages"],
            },
        ],
        targets: [],
        ongithub: true,
        kind: "on-premise",
        kindevidence: [],
        saasfoundry: true,
        ticketbranches: true,
        releaseworktree: "../SaaSFoundry-release",
        currentversion: "1.0.1",
        labels: [
            { path: "AGENTS.md", line: 177, text: "- Current version: 1.0.0-beta", version: "1.0.0-beta", pattern: "" },
        ],
        protection: {
            branch: "master",
            read: true,
            pullrequest: true,
            requiredchecks: ["CI / Required gate"],
            strict: true,
            noforcepush: true,
            restrictupdates: false,
            mergemethods: ["merge"],
            bypass: "never",
            sources: [{ code: "ruleset", path: "master", detail: "1" }],
        },
        divergence: {
            trunk: "develop",
            release: "master",
            read: true,
            ahead: 3,
            behind: 40,
            conflicts: true,
            conflictfiles: 2,
            notequivalent: 0,
            samples: [],
        },
    },
    defaults,
    options: defaults,
    rcformats: [{ id: "numeric", allowed: true }],
    branchmodels: [
        { id: "promote", allowed: false, reasons: [{ code: "protectedRelease", target: "master", refuses: true }] },
        { id: "single", allowed: true },
        { id: "rcpr", allowed: true },
    ],
    merges: [
        { id: "merge", allowed: true },
        { id: "squash", allowed: false, reasons: [{ code: "chainMerge", refuses: true }] },
        { id: "rebase", allowed: false, reasons: [{ code: "chainMerge", refuses: true }] },
    ],
    deploytargets: [],
    tagworkflows: {
        rc: [],
        public: [{ file: "publish-stable.yml", environments: ["npm-production"] }],
    },
    tagci: { rc: ["test.yml"], public: ["test.yml"] },
    proposal: { sources: {} },
    current: '{\n    "schema": 1,\n    "name": "SaaSFoundryAI",\n    "ci": {}\n}\n',
    base: "h",
    proposed: "",
    errors: [],
    validatewarnings: [],
    pr: {
        git: true,
        ref: "origin/develop",
        commit: "abc",
        target: "develop",
        ongithub: true,
        ticketrequired: true,
        branch: "feature/{N}-release-pipeline",
        subject: "chore(#{N}): set up the release pipeline",
        tickettitle: "Declare the release pipeline",
        uncommitted: false,
        included: false,
        localbase: "l",
    },
};

function keys(points: AnalysisPoint[]) {
    return points.map((p) => p.key);
}

describe("step 2a: the existing pipeline (FR-MC-040)", () => {
    const points = analysePipeline(survey, draft);

    it("reads the points in order, with their sources, and marks what is to confirm", () => {
        expect(keys(points)).toEqual([
            "branches",
            "protection",
            "merge",
            "publish",
            "hand",
            "dispatch/deploy-docs.yml",
            "rc",
        ]);
        expect(pendingPoints(points, {}).map((p) => p.key)).toEqual(["hand", "dispatch/deploy-docs.yml"]);
        const protection = points[1];
        expect(protection.text.key).toBe("protectionPr");
        expect(protection.extras.map((e) => e.key)).toEqual([
            "protectionChecks",
            "protectionNoBypass",
            "protectionPrWorkflows",
        ]);
        expect(protection.sources).toEqual([{ key: "ruleset", vars: { name: "master" } }]);
        expect(protection.choices.find((c) => c.id === "promote").allowed).toBe(false);
        expect(points[2].extras.map((e) => e.key)).toEqual(["mergeOnly", "mergeHistory"]);
        expect(points[3].text).toEqual({
            key: "publishTag",
            vars: { tag: "v{version}", workflows: "publish-stable.yml", targets: "npm, GitHub Release" },
        });
        expect(points[4].extras[0].key).toBe("handBehind");
        expect(points[6].selected).toBe("skip");
    });

    it("assumes a pull request and asks when GitHub could not be read", () => {
        const unread: SetupDraft = {
            ...draft,
            facts: {
                ...draft.facts,
                protection: { ...draft.facts.protection, read: false, error: "gh: not signed in", sources: [] },
            },
        };
        const p = analysePipeline(survey, unread).find((x) => x.key === "protection");
        expect(p.confirm).toBe(true);
        expect(p.selected).toBe("rcpr");
        expect(p.extras[0].vars.error).toBe("gh: not signed in");
    });

    it("draws the PR with its check, the merge commit, the tag's workflows, the targets and the docs dashed", () => {
        const model = existingFlowModel(survey, draft, points, {}, "public", t);
        const byKey = Object.fromEntries(model.nodes.map((n) => [n.key, n]));
        expect(model.viaPr).toBe(true);
        expect(byKey["public/open-pr"].kind).toBe("pr");
        expect(byKey["public/open-pr"].checks).toBe("CI / Required gate");
        expect(byKey["public/merge-pr"].label).toBe("merge commit");
        expect(byKey["public/@wf/publish-stable.yml"].approval).toBe("npm-production");
        expect(byKey["public/@ci/test.yml"]).toBeDefined();
        expect(byKey["public/@to/npm"].kind).toBe("target");
        expect(byKey["public/dispatch-deploy-docs.yml"].conditional).toBe(true);
        expect(byKey["public/dispatch-deploy-docs.yml"].question).toBe(true);
        expect(byKey["public/reconcile"].conditional).toBe(true);
        expect(byKey["public/sync-back"].kind).toBe("pr");
        const html = renderToStaticMarkup(<FlowDiagram model={model} selected="protection" onSelect={() => {}} />);
        expect(html).toContain("Published to");
        expect(html).toContain('data-testid="setup-diagram-selected"');
        expect(html).toContain('data-testid="setup-diagram-badge-6"');
        expect(html).toContain("setup-diagram-pr");
    });

    it("follows the answers: docs not run, hand steps left out, a release candidate kept", () => {
        const answers = { "dispatch/deploy-docs.yml": "no", hand: "no", rc: "keep" };
        const model = existingFlowModel(survey, draft, points, answers, "public", t);
        expect(model.nodes.some((n) => n.key.includes("deploy-docs"))).toBe(false);
        expect(model.nodes.some((n) => n.kind === "manual")).toBe(false);
        const rc = existingFlowModel(survey, draft, points, answers, "rc", t);
        expect(rc.nodes.find((n) => n.key === "rc/@tag").lane).toBe("rc");
        expect(rc.nodes.some((n) => n.kind === "pr")).toBe(false);
        const options = optionsOfAnswers(defaults, draft, points, answers);
        expect(options.dispatch).toEqual([]);
        expect(options.changelogs).toEqual([]);
        expect(options.labels).toEqual([]);
        expect(options.channels).toEqual(["rc", "public"]);
        const read = optionsOfAnswers(defaults, draft, points, {});
        expect(read.channels).toEqual(["public"]);
        expect(read.dispatch).toEqual(defaults.dispatch);
        expect(read.branchmodel).toBe("rcpr");
        expect(optionsOfAnswers(defaults, draft, points, {}, ["merge"]).channels).toEqual(defaults.channels);
    });

    it("goes by promotion when nothing protects the release branch", () => {
        const open: SetupDraft = {
            ...draft,
            defaults: { ...defaults, branchmodel: "promote" },
            facts: {
                ...draft.facts,
                protection: { ...draft.facts.protection, pullrequest: false, requiredchecks: [], bypass: "" },
            },
        };
        const p = analysePipeline(survey, open);
        expect(p.find((x) => x.key === "protection").text.key).toBe("protectionNone");
        const model = existingFlowModel(survey, open, p, {}, "public", t);
        expect(model.viaPr).toBe(false);
        expect(model.nodes[0].key).toBe("public/promote");
        expect(
            optionsOfAnswers({ ...defaults, branchmodel: "promote" }, open, p, { protection: "rcpr" }).branchmodel
        ).toBe("rcpr");
    });

    it("renders the points with their actions, and every key exists in English and French", () => {
        const html = renderToStaticMarkup(
            <AnalyseStep survey={survey} draft={draft} points={points} answers={{ rc: "skip" }} onAnswer={() => {}} />
        );
        expect(html).toContain("master only takes pull requests.<span> The check CI / Required gate must be green.");
        expect(html).toContain("GitHub ruleset &quot;master&quot;");
        expect(html).toContain("To confirm");
        expect(html).toContain("Yes, after publishing");
        expect(html).toContain("Confirmed");
        expect(html).toContain("Release candidate (none found)");
        const used = new Set<string>();
        for (const p of points) {
            for (const text of [p.text, ...p.extras]) {
                used.add(`mc.setup.analyse.point.${text.key}${text.count != null ? ".other" : ""}`);
            }
            for (const s of p.sources) {
                if (s.key) {
                    used.add(`mc.setup.analyse.source.${s.key}`);
                }
            }
        }
        for (const lang of ["en", "fr"]) {
            const dict = shippedDictionary(lang);
            for (const key of used) {
                expect(resolveKey(dict, key), `${lang} ${key}`).toBeTruthy();
            }
        }
    });
});
