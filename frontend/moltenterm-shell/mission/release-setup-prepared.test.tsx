// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./release-setup-client", () => ({
    setupDraft: vi.fn(),
    setupRefine: vi.fn(),
    setupWrite: vi.fn(),
    setupPrStatus: vi.fn(),
    setupTickets: vi.fn(),
}));
vi.mock("./mission-client", () => ({
    missionTrust: vi.fn(),
    missionUntrusted: vi.fn(),
    MissionRouteId: "molten:mission",
}));
vi.mock("./runs-view", () => ({ TrustPrompt: () => null }));

import { flowModel, SetupDraft, SetupOptions, SetupPrJob } from "./release-setup-model";
import { PreparedStep, PrFollow } from "./release-setup-prepared";
import {
    diffCounts,
    markFlow,
    newCommands,
    pipelineDiff,
    preparedDraft,
    preparedFiles,
    prFollowKey,
    proposedChecks,
    proposedFiles,
    proposesFormat,
    SetupPrStatus,
    toggledCheck,
} from "./release-setup-prepared-model";

const current = `{
    "schema": 1,
    "name": "SaaSFoundryAI",
    "icon": "rocket",
    "versions": {
        "tagprefix": "v",
        "files": [{ "path": "package.json", "format": "json", "keys": [["version"]] }]
    },
    "ci": { "jobs": [{ "name": "lint", "title": "Lint", "lane": "static", "run": "npm run lint" }] },
    "release": {
        "public": [
            { "id": "prepare", "title": "Prepare", "phase": "prepare", "run": "molten release prepare {tag}" },
            { "id": "finalize", "title": "Cut", "phase": "cut", "run": "molten release finalize {tag}" }
        ]
    }
}
`;

const changelog = {
    id: "changelog-en",
    title: "Write the {version} section of docs/changelog.md",
    phase: "cut" as const,
    manual: "In the release worktree, write the {version} section of docs/changelog.md.",
    check: { path: "docs/changelog.md", contains: "## [{version}]" },
    run: "",
};

const proposedRelease = {
    public: [
        {
            id: "prepare",
            title: "Prepare on the RC branch",
            phase: "prepare" as const,
            run: "molten release prepare {tag} --pr",
        },
        changelog,
        { id: "open-pr", title: "Open the pull request", phase: "cut" as const, run: "molten release open-pr {tag}" },
        { id: "tag", title: "Tag", phase: "cut" as const, run: "molten release tag {tag}" },
    ],
};

const proposed = `{
    "schema": 1,
    "name": "SaaSFoundryAI",
    "icon": "rocket",
    "versions": {
        "tagprefix": "v",
        "files": [
            { "path": "package.json", "format": "json", "keys": [["version"]] },
            { "path": "README.md", "format": "text", "pattern": "\\\\*\\\\*v{version}\\\\*\\\\*" }
        ],
        "format": "npm run format --"
    },
    "ci": { "jobs": [{ "name": "lint", "title": "Lint", "lane": "static", "run": "npm run lint" }] },
    "release": ${JSON.stringify(proposedRelease)}
}
`;

const options: SetupOptions = {
    kind: "on-premise",
    channels: ["public"],
    branchmodel: "rcpr",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: ["docs/changelog.md"],
    ciworkflows: [],
    dispatch: [],
    notes: false,
    notespath: "releases/{tag}.md",
    syncback: false,
    milestone: false,
    manual: [],
    environments: [],
    reconcile: false,
    labels: [],
};

const draft: SetupDraft = {
    provider: "moltenterm",
    warnings: [],
    facts: {
        name: "SaaSFoundryAI",
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
        targets: [],
        ongithub: true,
        kind: "on-premise",
        kindevidence: [],
        saasfoundry: true,
        ticketbranches: true,
        releaseworktree: "../SaaSFoundry-release",
        labels: [],
    },
    defaults: options,
    options,
    rcformats: [],
    branchmodels: [],
    merges: [],
    deploytargets: [],
    tagworkflows: { rc: [], public: [] },
    proposal: { release: proposedRelease, versions: { format: "npm run format --" }, sources: {} },
    current,
    base: "h",
    proposed,
    errors: [],
    validatewarnings: [],
    recordexists: false,
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

describe("step 3's exact changes (#1104)", () => {
    it("reads the proposed file change by change, and names what it leaves untouched", () => {
        const diff = pipelineDiff(current, proposed);
        expect(diff.steps.map((c) => `${c.kind}:${c.key}`)).toEqual([
            "changed:public/prepare",
            "added:public/changelog-en",
            "added:public/open-pr",
            "added:public/tag",
            "removed:public/finalize",
        ]);
        expect(diff.steps[1].manual).toBe(true);
        expect(diff.steps[1].check).toEqual({ path: "docs/changelog.md", contains: "## [{version}]" });
        expect(diff.fields.map((c) => `${c.kind}:${c.key}`)).toEqual(["added:versions.files", "added:versions.format"]);
        expect(diff.untouched).toEqual(["name", "icon", "ci"]);
        expect(diffCounts(diff)).toEqual({ added: 5, changed: 1, removed: 1 });
        expect(pipelineDiff("not json", proposed)).toBeNull();
    });

    it("lists only the commands the pull request adds or changes", () => {
        expect(newCommands(current, proposed)).toEqual([
            { run: "molten release prepare {tag} --pr", places: ["public/prepare"] },
            { run: "molten release open-pr {tag}", places: ["public/open-pr"] },
            { run: "molten release tag {tag}", places: ["public/tag"] },
            { run: "npm run format --", places: ["versions.format"] },
        ]);
        expect(newCommands(proposed, proposed)).toEqual([]);
    });

    it("tells the draft's proposed checks and formatter, and keeps the dropped ones to take back", () => {
        expect(proposedChecks(draft, options)).toEqual(["changelog-en"]);
        expect(proposesFormat(draft, options)).toBe(true);
        const dropped = toggledCheck(options, "changelog-en", false);
        expect(dropped.nocheck).toEqual(["changelog-en"]);
        expect(toggledCheck(dropped, "changelog-en", true).nocheck).toEqual([]);
        const redrafted = { ...draft, proposal: { ...draft.proposal, release: { public: [] }, versions: undefined } };
        expect(proposedChecks(redrafted, dropped)).toEqual(["changelog-en"]);
        expect(proposesFormat(redrafted, { ...options, noformat: true })).toBe(true);
        expect(proposesFormat(redrafted, options)).toBe(false);
    });

    it("lists the files the pull request writes, with a place for one more generated file", () => {
        const extra = [
            { path: "docs/pipeline.md", status: "new" as const, kind: "whole" as const, content: "# Pipeline\n" },
        ];
        expect(preparedFiles(draft, proposed, extra).map((f) => `${f.status}:${f.kind}:${f.path}`)).toEqual([
            "changed:pipeline:.molten/project.json",
            "new:record:.molten/release-setup.json",
            "new:whole:docs/pipeline.md",
        ]);
        expect(preparedFiles({ ...draft, recordexists: true }, proposed)[1].status).toBe("changed");
        const workflow = proposedFiles([
            { path: ".github/workflows/molten-publish.yml", content: "name: x\n", targets: ["npm"] },
        ]);
        expect(workflow).toEqual([
            {
                path: ".github/workflows/molten-publish.yml",
                status: "new",
                kind: "whole",
                content: "name: x\n",
                introKey: "mc.setup.describe.fileIntro",
                targets: ["npm"],
                warningKey: "mc.setup.describe.npmSecret",
            },
        ]);
        const html = renderToStaticMarkup(
            <PreparedStep
                dir="/p"
                draft={draft}
                options={options}
                refined={null}
                onRefined={() => {}}
                onRefining={() => {}}
                extraFiles={workflow}
            />
        );
        expect(html).toContain(".github/workflows/molten-publish.yml");
        expect(html).toContain("Proposed because no workflow publishes on the tag yet to: npm");
        expect(preparedFiles(draft, current)).toHaveLength(1);
    });

    it("draws the proposed steps with their marks, so the diagram follows the agent's ticks", () => {
        const refinedText = proposed.replace('"id":"tag","title":"Tag"', '"id":"tag","title":"Tag it"');
        const drawn = preparedDraft(draft, refinedText);
        const model = markFlow(flowModel(drawn, "public", "v"), pipelineDiff(current, refinedText));
        expect(model.nodes.find((n) => n.key === "public/tag").label).toBe("Tag it");
        expect(model.nodes.find((n) => n.key === "public/changelog-en").mark).toBe("added");
        expect(model.nodes.find((n) => n.key === "public/prepare").mark).toBe("changed");
    });
});

describe("step 3's view (#1104)", () => {
    it("shows the diagram, the changes by file, the proposals and the commands to approve", () => {
        const html = renderToStaticMarkup(
            <PreparedStep
                dir="/p"
                draft={draft}
                options={options}
                refined={null}
                onRefined={() => {}}
                onRefining={() => {}}
                onOptions={() => {}}
            />
        );
        expect(html).toContain('data-testid="setup-diagram-mark-added"');
        expect(html).toContain("+ added, ~ changed.");
        expect(html).toContain("Exact changes");
        expect(html).toContain("name, icon, ci unchanged");
        expect(html).toContain('data-testid="prepared-step-public/changelog-en"');
        expect(html).toContain("Checked before “Mark as done”: docs/changelog.md contains “## [{version}]”.");
        expect(html).toContain('data-testid="prepared-check-toggle-changelog-en"');
        expect(html).toContain('data-testid="prepared-format-toggle"');
        expect(html).toContain(".molten/release-setup.json");
        expect(html).toContain("Ask the project&#x27;s agent");
        expect(html).toContain("Commands to approve");
        expect(html).toContain("molten release open-pr {tag}");
        expect(html).not.toContain("npm run lint</code>");
    });

    it("keeps a dropped proposal in the list, and locks the ticks while an agent's proposal is shown", () => {
        const html = renderToStaticMarkup(
            <PreparedStep
                dir="/p"
                draft={{ ...draft, proposal: { ...draft.proposal, versions: undefined } }}
                options={{ ...options, noformat: true }}
                refined={null}
                onRefined={() => {}}
                onRefining={() => {}}
                onOptions={() => {}}
            />
        );
        expect(html).toContain('data-testid="prepared-format-dropped"');
        const refined = renderToStaticMarkup(
            <PreparedStep
                dir="/p"
                draft={draft}
                options={options}
                refined={{ agentname: "Claude Code", proposed, errors: [], validatewarnings: [] }}
                onRefined={() => {}}
                onRefining={() => {}}
                onOptions={() => {}}
            />
        );
        expect(refined).toMatch(
            /data-testid="prepared-check-toggle-changelog-en" disabled=""|disabled="" [^>]*data-testid="prepared-check-toggle-changelog-en"/
        );
        expect(refined).toContain("drop the proposal to change them");
    });
});

const job: SetupPrJob = {
    id: "j",
    dir: "/p",
    kind: "write",
    mode: "pr",
    steps: [],
    finished: true,
    ref: "origin/develop",
    target: "develop",
    ongithub: true,
    prnumber: 42,
    prurl: "https://github.com/o/r/pull/42",
    files: [],
};

const status = (s: Partial<SetupPrStatus>): SetupPrStatus => ({
    number: 42,
    url: "",
    state: "open",
    draft: true,
    head: "chore/release-pipeline",
    base: "develop",
    checks: "pending",
    success: 0,
    failure: 0,
    pending: 2,
    ...s,
});

describe("the pull request followed in step 3 (#1104)", () => {
    it("says where the pull request is", () => {
        expect(prFollowKey(status({}))).toBe("mc.setup.prepared.follow.running");
        expect(prFollowKey(status({ checks: "failure", failure: 1 }))).toBe("mc.setup.prepared.follow.failed");
        expect(prFollowKey(status({ checks: "success" }))).toBe("mc.setup.prepared.follow.greenDraft");
        expect(prFollowKey(status({ checks: "success", draft: false }))).toBe("mc.setup.prepared.follow.green");
        expect(prFollowKey(status({ state: "merged" }))).toBe("mc.setup.prepared.follow.merged");
        expect(prFollowKey(status({ state: "closed" }))).toBe("mc.setup.prepared.follow.closed");
    });

    it("shows the line and the ways to open it", () => {
        const html = renderToStaticMarkup(
            <PrFollow dir="/p" job={job} status={status({})} error={false} onOpenReviews={() => {}} />
        );
        expect(html).toContain("Draft pull request #42: its checks are running (2 to go).");
        expect(html).toContain("Open #42 in Control room");
        expect(html).toContain("Open on GitHub");
        const merged = renderToStaticMarkup(
            <PrFollow
                dir="/p"
                job={job}
                status={status({ state: "merged", checks: "success" })}
                error={false}
                onOpenReviews={() => {}}
            />
        );
        expect(merged).toContain("#42 is merged into develop");
        expect(
            renderToStaticMarkup(
                <PrFollow
                    dir="/p"
                    job={{ ...job, failure: { code: "push" } }}
                    status={null}
                    error={false}
                    onOpenReviews={() => {}}
                />
            )
        ).toBe("");
    });
});
