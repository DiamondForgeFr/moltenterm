// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DescribeStep } from "./release-setup-describe";
import {
    availableTargets,
    branchChoices,
    describeDefaults,
    describes,
    sameBranch,
    SetupModel,
    targetRows,
    toggledTarget,
    undescribed,
    withRc,
} from "./release-setup-describe-model";
import type { SetupDraft, SetupOptions } from "./release-setup-model";

const base: SetupOptions = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "promote",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: [],
    ciworkflows: [],
    dispatch: [],
    notes: false,
    notespath: "releases/{tag}.md",
    syncback: true,
    milestone: true,
    manual: [],
    environments: [],
    reconcile: false,
    labels: [],
};

const publishText =
    'name: Publish\non:\n  push:\n    tags:\n      - "v*"\njobs:\n  npm:\n    steps:\n      - run: npm publish\n';

function draftOf(options: SetupOptions, extra?: Partial<SetupDraft>): SetupDraft {
    return {
        provider: "moltenterm",
        warnings: [],
        facts: {
            name: "invoice-cli",
            haspipeline: false,
            missing: ["rc", "public"],
            branches: { trunk: "develop", release: "main" },
            tagprefix: "v",
            versionsdeclared: false,
            versionsource: { code: "versionPackage", path: "package.json" },
            notesdeclared: false,
            notespath: "releases/{tag}.md",
            notesfound: false,
            changelogs: [],
            workflows: [
                {
                    file: "molten-publish.yml",
                    push: true,
                    tags: ["v*"],
                    dispatch: false,
                    role: "publish",
                    ships: ["npm"],
                },
            ],
            targets: [{ id: "npm", packager: "npm", source: { code: "targetNpm", path: "package.json" } }],
            ongithub: true,
            kind: "on-premise",
            kindevidence: [],
            saasfoundry: false,
            ticketbranches: false,
            releaseworktree: "../invoice-cli-release",
            labels: [],
        },
        defaults: base,
        options,
        rcformats: [],
        branchmodels: [],
        merges: [],
        deploytargets: [],
        tagworkflows: {
            rc: [{ file: "molten-publish.yml", environments: [] }],
            public: [{ file: "molten-publish.yml", environments: [] }],
        },
        proposal: {
            release: {
                rc: [
                    { id: "promote", title: "Promote", phase: "prepare", run: "molten release promote" },
                    { id: "finalize", title: "Cut", phase: "cut", run: "molten release finalize {tag}" },
                ],
                public: [{ id: "finalize", title: "Cut", phase: "cut", run: "molten release finalize {tag}" }],
            },
            sources: {},
        },
        current: "",
        base: "",
        proposed: "{}\n",
        errors: [],
        validatewarnings: [],
        files: [{ path: ".github/workflows/molten-publish.yml", content: publishText, targets: ["npm"] }],
        branchnames: ["develop", "feature/1-x", "main"],
        pr: {
            git: true,
            ref: "origin/develop",
            commit: "abc",
            target: "develop",
            ongithub: true,
            ticketrequired: false,
            branch: "chore/release-pipeline",
            subject: "chore: set up the release pipeline",
            tickettitle: "",
            uncommitted: false,
            included: false,
            localbase: "",
        },
        ...extra,
    };
}

describe("step 2b: describe a new pipeline (FR-MC-041)", () => {
    it("opens on the project's branches and every target it can reach", () => {
        const draft = draftOf(base);
        expect(availableTargets(draft)).toEqual(["npm", "githubrelease"]);
        const o = describeDefaults(draft, base);
        expect(o).toMatchObject({
            trunk: "develop",
            release: "main",
            rc: "published",
            publish: ["npm", "githubrelease"],
        });
        const offGithub = draftOf(base, {
            facts: { ...draft.facts, ongithub: false, targets: [] },
        });
        expect(describeDefaults(offGithub, base)).toMatchObject({ rc: "internal", publish: [] });
        // A new repository without the published branch yet (#1106): the trunk is the published branch.
        expect(describeDefaults(draftOf(base, { branchnames: ["develop"] }), base)).toMatchObject({
            trunk: "develop",
            release: "develop",
        });
        // An answer already given stays.
        expect(describeDefaults(draft, { ...base, rc: "none", publish: [] })).toMatchObject({
            rc: "none",
            publish: [],
        });
    });

    it("maps the release candidate answer onto the channels, and leaves path 2a undescribed", () => {
        expect(withRc(base, "none").channels).toEqual(["public"]);
        expect(withRc(base, "internal").channels).toEqual(["rc", "public"]);
        const described = { ...base, trunk: "main", release: "main", rc: "none" as const, publish: ["npm"] };
        expect(sameBranch(described)).toBe(true);
        expect(undescribed(described)).toEqual(base);
        expect(describes("describe", "cli")).toBe(true);
        expect(describes("describe", "web")).toBe(false);
        expect(describes("analyse", "cli")).toBe(false);
    });

    it("says which targets get the proposed workflow and which are already published", () => {
        const o = { ...base, publish: ["npm"] };
        expect(targetRows(draftOf(o), o)).toEqual([
            { id: "npm", on: true, publishedBy: undefined, proposed: true },
            { id: "githubrelease", on: false, publishedBy: undefined, proposed: false },
        ]);
        const existing = draftOf(o, {
            files: [],
            tagworkflows: { rc: [], public: [{ file: "release.yml", environments: [] }] },
        });
        existing.facts.workflows = [
            { file: "release.yml", push: true, tags: ["v*"], dispatch: false, role: "publish", ships: ["npm"] },
        ];
        expect(targetRows(existing, o)[0]).toMatchObject({ id: "npm", publishedBy: "release.yml", proposed: false });
        expect(toggledTarget(o, "githubrelease", true).publish).toEqual(["npm", "githubrelease"]);
        expect(toggledTarget(o, "npm", false).publish).toEqual([]);
        expect(branchChoices(draftOf(o), { ...o, trunk: "trunk" })).toEqual([
            "trunk",
            "develop",
            "feature/1-x",
            "main",
        ]);
    });

    it("renders the questions, the model list and the diagrams", () => {
        const o = describeDefaults(draftOf(base), base);
        const models: SetupModel[] = [{ dir: "/m", name: "SaaSFoundryAI", ref: "origin/develop", options: o }];
        const html = renderToStaticMarkup(
            <DescribeStep
                draft={draftOf(o)}
                options={o}
                from="model"
                models={models}
                model="/m"
                words="The changelog is in English only."
                appType="cli"
                onChange={() => {}}
                onFrom={() => {}}
                onWords={() => {}}
            >
                <span>all the choices here</span>
            </DescribeStep>
        );
        expect(html).toContain("MoltenTerm&#x27;s standard pipeline (CLI)");
        expect(html).toContain("SaaSFoundryAI · origin/develop");
        expect(html).toContain("Where does everyday work land?");
        expect(html).toContain("the same branch (develop): versions are tagged on it");
        expect(html).toContain("a publish workflow on the tag will be proposed (none exists)");
        expect(html).toContain("Yes, published under a pre-release tag");
        expect(html).toContain("npm&#x27;s next tag · tag vX.Y.Z-1");
        expect(html).toContain("The changelog is in English only.");
        expect(html).toContain("All the choices");
        expect(html.match(/data-testid="setup-diagram"/g)).toHaveLength(2);

        const none = renderToStaticMarkup(
            <DescribeStep
                draft={draftOf(withRc(o, "none"))}
                options={withRc(o, "none")}
                from="standard"
                models={[]}
                model=""
                words=""
                appType="cli"
                onChange={() => {}}
                onFrom={() => {}}
                onWords={() => {}}
            />
        );
        expect(none).toContain("No other linked project has a pipeline committed in its repository yet.");
        expect(none.match(/data-testid="setup-diagram"/g)).toHaveLength(1);
    });

    // #1106: step 1's "Use a template" with none saved, and a forgotten template whose choices stay.
    it("says when no template is saved yet, and that a forgotten template's choices are kept", () => {
        const o = describeDefaults(draftOf(base), base);
        const html = renderToStaticMarkup(
            <DescribeStep
                draft={draftOf(o)}
                options={o}
                from="template"
                models={[]}
                model=""
                words=""
                appType="cli"
                templates={[]}
                template=""
                askedTemplate
                onChange={() => {}}
                onFrom={() => {}}
                onWords={() => {}}
            />
        );
        expect(html).toContain("No template is saved on this computer yet");
        const forgotten = renderToStaticMarkup(
            <DescribeStep
                draft={draftOf(o)}
                options={o}
                from="standard"
                models={[]}
                model=""
                words=""
                appType="cli"
                templates={[]}
                forgotten="My CLI"
                onChange={() => {}}
                onFrom={() => {}}
                onWords={() => {}}
            />
        );
        expect(forgotten).toContain("“My CLI” is forgotten on this computer; the choices it filled in are kept below");
        expect(forgotten).not.toContain("No template is saved");
    });
});
