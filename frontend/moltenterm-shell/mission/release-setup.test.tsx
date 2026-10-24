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
        { id: "rcpr", allowed: false, reasons: [{ code: "chainNoRcPr", refuses: true }] },
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
        expect(html).toContain("does not open release branches by pull request yet");
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

    it("draws the flow with its phases and the tag", () => {
        const html = renderToStaticMarkup(<FlowDiagram model={flowModel(draft, "public", "v")} />);
        expect(html).toContain("vX.Y.Z");
        expect(html).toContain('data-kind="workflow"');
        expect(html).toContain("Prepare");
    });
});
