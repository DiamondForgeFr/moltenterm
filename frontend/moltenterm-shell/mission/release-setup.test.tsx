// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./release-setup-client", () => ({ setupDraft: vi.fn(), setupRefine: vi.fn(), setupWrite: vi.fn() }));
vi.mock("./mission-client", () => ({
    missionTrust: vi.fn(),
    missionUntrusted: vi.fn(),
    MissionRouteId: "molten:mission",
}));
vi.mock("./runs-view", () => ({ TrustPrompt: () => null }));

import { ChoicesStep, KindStep, ReviewStep } from "./release-setup";
import { FlowDiagram } from "./release-setup-diagram";
import { flowModel, SetupDraft, SetupOptions } from "./release-setup-model";

const options: SetupOptions = {
    kind: "on-premise",
    channels: ["public"],
    branchmodel: "promote",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: ["docs/changelog.md"],
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

const draft: SetupDraft = {
    provider: "moltenterm",
    warnings: [],
    facts: {
        name: "P",
        haspipeline: true,
        missing: ["rc", "public"],
        branches: { trunk: "develop", release: "master" },
        tagprefix: "v",
        versionsdeclared: true,
        versionsource: { code: "versionsDeclared", path: ".molten/project.json" },
        notesdeclared: false,
        notespath: "releases/{tag}.md",
        notesfound: false,
        changelogs: [{ path: "docs/changelog.md", lang: "en" }],
        workflows: [],
        targets: [
            {
                id: "msi",
                packager: "electron-builder",
                source: { code: "targetConfig", path: "electron-builder.config.cjs", detail: "msi" },
            },
        ],
        ongithub: true,
        kind: "on-premise",
        kindevidence: [{ code: "targetConfig", path: "electron-builder.config.cjs", detail: "msi" }],
        saasfoundry: false,
        ticketbranches: false,
        releaseworktree: "../P-release",
        labels: [],
    },
    defaults: options,
    options,
    rcformats: [
        { id: "numeric", allowed: true },
        { id: "rcdot", allowed: false, reasons: [{ code: "msiNumeric", target: "msi", refuses: true }] },
    ],
    branchmodels: [
        { id: "promote", allowed: true },
        { id: "single", allowed: true },
        { id: "rcpr", allowed: false, reasons: [{ code: "singleBranch", refuses: true }] },
    ],
    merges: [{ id: "merge", allowed: true }],
    deploytargets: [],
    tagworkflows: { rc: [], public: [{ file: "release.yml", environments: [] }] },
    proposal: {
        release: {
            public: [
                { id: "prepare", title: "Prepare", phase: "prepare", run: "molten release prepare {tag}" },
                { id: "finalize", title: "Cut", phase: "cut", run: "molten release finalize {tag}" },
            ],
        },
        sources: { "public/prepare": { code: "versionsDeclared", path: ".molten/project.json" } },
    },
    current: '{\n    "schema": 1,\n    "name": "P"\n}\n',
    base: "h",
    proposed: '{\n    "schema": 1,\n    "name": "P",\n    "release": {}\n}\n',
    errors: [],
    validatewarnings: [],
    pr: {
        git: true,
        ref: "origin/develop",
        commit: "abc1234",
        target: "develop",
        ongithub: true,
        ticketrequired: false,
        branch: "chore/release-pipeline",
        subject: "chore(release): set up the release pipeline",
        tickettitle: "Declare the release pipeline",
        uncommitted: false,
        included: false,
        localbase: "l",
    },
};

describe("release setup stepper (FR-MC-036, DS-MC-030)", () => {
    it("confirms the detected kind with its evidence", () => {
        const html = renderToStaticMarkup(<KindStep draft={draft} options={options} onKind={() => {}} />);
        expect(html).toContain("Distributed app");
        expect(html).toContain("Detected");
        expect(html).toContain("msi target in electron-builder.config.cjs");
    });

    it("explains why a version format or a branch model is unavailable", () => {
        const html = renderToStaticMarkup(
            <ChoicesStep draft={draft} options={options} onChange={() => {}} channel="public" setChannel={() => {}} />
        );
        expect(html).toContain("Windows installers only accept numbers after the dash (msi target).");
        expect(html).toContain("The trunk is also the release branch.");
        expect(html).toContain("Update docs/changelog.md (EN)");
        expect(html).toContain("release.yml starts on the tag");
    });

    it("reviews the diff and says who proposed it", () => {
        const html = renderToStaticMarkup(
            <ReviewStep
                draft={draft}
                options={options}
                refined={null}
                refining={false}
                onRefine={() => {}}
                onDropRefined={() => {}}
            />
        );
        expect(html).toContain("Drafted by MoltenTerm from the repository.");
        expect(html).toContain("Refine with an agent");
        expect(html).toContain("&quot;release&quot;: {}");
        const refined = renderToStaticMarkup(
            <ReviewStep
                draft={draft}
                options={options}
                refined={{
                    agent: "claude",
                    agentname: "Claude Code",
                    proposed: '{"schema":1}\n',
                    errors: [],
                    validatewarnings: [],
                }}
                refining={false}
                onRefine={() => {}}
                onDropRefined={() => {}}
            />
        );
        expect(refined).toContain("Proposed by Claude Code");
        expect(refined).toContain("Back to the draft");
    });

    it("wraps a long manual text instead of cutting it, and scrolls long diff lines inside the diff (#1047)", () => {
        const text = "git fetch origin && git checkout rc-1.0.0 && git merge -s ours origin/master --no-edit";
        const html = renderToStaticMarkup(
            <ChoicesStep
                draft={draft}
                options={{ ...options, manual: [{ id: "reconcile", title: "Reconcile", text }] }}
                onChange={() => {}}
                channel="public"
                setChannel={() => {}}
            />
        );
        const row = html.slice(html.indexOf('data-testid="setup-manual-row"'));
        expect(row).toContain(text.replace(/&/g, "&amp;"));
        expect(row.slice(0, row.indexOf(text.slice(0, 9)))).not.toContain("truncate");
        expect(row).toMatch(/class="[^"]*whitespace-pre-wrap[^"]*wrap-anywhere/);
        const review = renderToStaticMarkup(
            <ReviewStep
                draft={draft}
                options={options}
                refined={null}
                refining={false}
                onRefine={() => {}}
                onDropRefined={() => {}}
            />
        );
        expect(review).toMatch(/class="[^"]*overflow-auto[^"]*" data-testid="setup-diff"/);
        expect(review).toContain("flex w-max min-w-full whitespace-pre");
    });

    it("draws the flow with its phases and the tag", () => {
        const html = renderToStaticMarkup(<FlowDiagram model={flowModel(draft, "public", "v")} />);
        expect(html).toContain("vX.Y.Z");
        expect(html).toContain('data-kind="workflow"');
        expect(html).toContain("Prepare");
        expect(html).not.toContain("setup-diagram-pr");
    });
});

// A protected, diverged release branch shaped like SaaSFoundryAI's (#1046).
const prOptions: SetupOptions = {
    ...options,
    branchmodel: "rcpr",
    reconcile: true,
    labels: [{ path: "README.md", line: 7, pattern: "\\*\\*v{version}\\*\\*" }],
};

const prDraft: SetupDraft = {
    ...draft,
    facts: {
        ...draft.facts,
        rcbranchpattern: "rc-{version}",
        currentversion: "1.0.1",
        labels: [
            { path: "README.md", line: 7, text: "**v1.0.1**", version: "1.0.1", pattern: "\\*\\*v{version}\\*\\*" },
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
            mergemethods: ["merge", "squash", "rebase"],
            bypass: "never",
            sources: [{ code: "ruleset", path: "Protect release branches", detail: "24043198" }],
        },
        divergence: {
            trunk: "develop",
            release: "master",
            read: true,
            ahead: 96,
            behind: 184,
            conflicts: true,
            conflictfiles: 42,
            notequivalent: 0,
            samples: [],
        },
    },
    branchmodels: [
        {
            id: "promote",
            allowed: false,
            reasons: [{ code: "protectedRelease", target: "master", refuses: true }],
        },
        { id: "single", allowed: true },
        { id: "rcpr", allowed: true },
    ],
    options: prOptions,
    proposal: {
        release: {
            public: [
                { id: "prepare", title: "Prepare", phase: "prepare", run: "molten release prepare {tag} --pr" },
                { id: "reconcile", title: "Reconcile", phase: "prepare", run: "molten release reconcile {tag}" },
                { id: "changelog-en", title: "Changelog", phase: "cut", manual: "Write it", run: "" },
                { id: "open-pr", title: "Open", phase: "cut", confirm: "Pushes", run: "molten release open-pr {tag}" },
                {
                    id: "merge-pr",
                    title: "Merge",
                    phase: "cut",
                    confirm: "Merges",
                    run: "molten release merge-pr {tag} --method merge",
                },
                { id: "tag", title: "Tag", phase: "cut", confirm: "Public", run: "molten release tag {tag}" },
                { id: "sync-back", title: "Back", phase: "back", run: "molten release sync-back {tag}" },
            ],
        },
        sources: {},
    },
};

describe("release setup of a protected release branch (#1046)", () => {
    it("says why the flow goes by pull request, with the divergence's numbers", () => {
        const html = renderToStaticMarkup(
            <ReviewStep
                draft={prDraft}
                options={prOptions}
                refined={null}
                refining={false}
                onRefine={() => {}}
                onDropRefined={() => {}}
            />
        );
        expect(html).toContain("Why this flow");
        expect(html).toContain(
            "master asks for a pull request, the checks CI / Required gate on a branch up to date with master (the ruleset “Protect release branches”) and nobody can bypass it: the release goes through rc-X.Y.Z"
        );
        expect(html).toContain("master has 96 commits develop does not, and develop has 184 that master does not.");
        expect(html).toContain("Merging them conflicts in 42 files.");
        expect(html).toContain("a one-time merge -s ours on the RC branch");
    });

    it("offers the reconciliation, refuses the promotion and lists the labels", () => {
        const html = renderToStaticMarkup(
            <ChoicesStep
                draft={prDraft}
                options={prOptions}
                onChange={() => {}}
                channel="public"
                setChannel={() => {}}
            />
        );
        expect(html).toContain("master takes changes by pull request only");
        expect(html).toContain("Reconcile master into rc-X.Y.Z when they diverged");
        expect(html).toContain('data-testid="setup-reconcile"');
        expect(html).toContain("README.md:7");
        expect(html).toContain("No pattern finds this line alone");
    });

    it("warns instead of reconciling when a commit has no equivalent on the trunk", () => {
        const lossy: SetupDraft = {
            ...prDraft,
            facts: {
                ...prDraft.facts,
                divergence: { ...prDraft.facts.divergence, notequivalent: 1, samples: ["abc123 fix: only on master"] },
            },
        };
        const html = renderToStaticMarkup(
            <ChoicesStep draft={lossy} options={prOptions} onChange={() => {}} channel="public" setChannel={() => {}} />
        );
        expect(html).toContain("1 commit of master has no equivalent on develop (abc123 fix: only on master)");
        expect(html).not.toContain('data-testid="setup-reconcile"');
    });

    it("draws the RC branch and its pull request into the release branch", () => {
        const model = flowModel(prDraft, "public", "v");
        expect(model.viaPr).toBe(true);
        expect(model.promote).toBe(false);
        expect(model.nodes.find((n) => n.key === "public/prepare").lane).toBe("rc");
        expect(model.nodes.find((n) => n.key === "public/open-pr").lane).toBe("rc");
        expect(model.nodes.find((n) => n.key === "public/tag").lane).toBe("release");
        const html = renderToStaticMarkup(<FlowDiagram model={model} />);
        expect(html).toContain("rc-X.Y.Z");
        expect(html).toContain('data-testid="setup-diagram-pr"');
        expect(html).toContain('data-testid="setup-diagram-branch"');
    });
});
