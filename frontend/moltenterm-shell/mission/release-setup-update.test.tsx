// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2a for a project already set up (FR-MC-040 AC8–AC12, #1102; the #1086 update, FR-MC-036): the declared
// pipeline drawn with the changes, the numbered list, the up-to-date state, and the menu's single entry.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./release-setup-client", () => ({
    setupDraft: vi.fn(),
    setupRefine: vi.fn(),
    setupWrite: vi.fn(),
    setupCheck: vi.fn(),
    setupUpdate: vi.fn(),
}));
vi.mock("./mission-client", () => ({
    missionTrust: vi.fn(),
    missionUntrusted: vi.fn(),
    missionRefresh: vi.fn(),
    releaseMilestone: vi.fn(),
    releaseStart: vi.fn(),
    MissionRouteId: "molten:mission",
}));
vi.mock("./runs-view", () => ({ TrustPrompt: () => null }));

import { I18nModel } from "../i18n/i18n";
import type { ReleasePhase } from "./mission-model";
import { ReleaseSetupUpdateButton } from "./release-menu";
import { FlowDiagram } from "./release-setup-diagram";
import { changeGroups, changeTaken, SetupCheck, SetupDraft, SetupFacts, SetupOptions } from "./release-setup-model";
import { changeNumbers, UpdateFiles, updateFlowModel, updateReady, UpdateStep } from "./release-setup-update";

const options: SetupOptions = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "rcpr",
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
    reconcile: true,
    labels: [],
};

const draft = {
    provider: "moltenterm",
    warnings: [],
    facts: {
        branches: { trunk: "develop", release: "master" },
        rcbranchpattern: "rc-{version}",
        tagprefix: "v",
        workflows: [],
        changelogs: [],
    } as unknown as SetupFacts,
    defaults: options,
    options,
    tagworkflows: { rc: [], public: [{ file: "publish-stable.yml", environments: ["npm-production"] }] },
    proposal: { sources: {} },
} as unknown as SetupDraft;

const step = (id: string, run: string, phase: ReleasePhase = "cut") => ({ id, title: id, phase, run });

const check: SetupCheck = {
    state: "update",
    reasons: [{ code: "local" }, { code: "protected", detail: "master" }, { code: "template" }],
    changes: [
        {
            key: "local/public/tag",
            channel: "public",
            id: "tag",
            kind: "changed",
            title: "Tag the merge commit",
            before: "{}",
            after: "{}",
            customised: false,
            take: true,
            local: true,
        },
        {
            key: "local/file",
            kind: "changed",
            title: "ci, versions",
            before: "{}",
            after: "{}",
            customised: false,
            take: true,
            local: true,
        },
        {
            key: "public/promote",
            channel: "public",
            id: "promote",
            kind: "removed",
            title: "Promote develop onto master",
            before: "{}",
            customised: false,
            take: true,
        },
        {
            key: "public/open-pr",
            channel: "public",
            id: "open-pr",
            kind: "added",
            title: "Open the pull request",
            after: "{}",
            customised: false,
            take: true,
        },
        {
            key: "public/sync-back",
            channel: "public",
            id: "sync-back",
            kind: "changed",
            title: "Merge master back into develop",
            before: "./scripts/sync-back.sh",
            after: "molten release sync-back {tag} --merge",
            customised: true,
            take: false,
        },
        { key: "versions", kind: "versions", before: "{}", after: "{}", customised: false, take: true },
    ],
    recordtemplate: 1,
    template: 2,
    releasebranch: "master",
    current: "{\n}\n",
    base: "b",
    proposed: '{\n    "release": {}\n}\n',
    signature: "s",
    errors: [],
    validatewarnings: [],
    options,
    drawn: {
        rc: [step("prepare", "molten release prepare {tag} --pr", "prepare")],
        public: [
            step("promote", "molten release promote {tag}", "prepare"),
            step("prepare", "molten release prepare {tag} --pr", "prepare"),
            step("open-pr", "molten release open-pr {tag}"),
            step("merge-pr", "molten release merge-pr {tag} --method merge"),
            step("tag", "molten release tag {tag}"),
            step("sync-back", "molten release sync-back {tag} --merge", "back"),
        ],
    },
    pr: {
        git: true,
        ref: "origin/develop",
        commit: "abc1234",
        target: "develop",
        ongithub: true,
        ticketrequired: false,
        branch: "chore/release-pipeline",
        subject: "chore(release): update the release setup",
        tickettitle: "Update the release setup",
        uncommitted: true,
        included: true,
        localbase: "l",
    },
};

const upToDate: SetupCheck = {
    ...check,
    state: "uptodate",
    reasons: [],
    changes: [],
    recordtemplate: 0,
    proposed: check.current,
    pr: { ...check.pr, uncommitted: false, included: false },
};

describe("step 2a for a project already set up (#1102)", () => {
    it("keeps a customised change unless the developer ticks it", () => {
        const custom = check.changes[4];
        expect(changeTaken(custom, {})).toBe(false);
        expect(changeTaken(custom, { "public/sync-back": true })).toBe(true);
        expect(changeTaken(check.changes[2], { "public/promote": false })).toBe(false);
    });

    it("lists the uncommitted edits first, then by channel, the version files last, numbered in that order", () => {
        expect(changeGroups(check.changes).map((g) => [g.group, g.changes.map((c) => c.key)])).toEqual([
            ["local", ["local/public/tag", "local/file"]],
            ["public", ["public/promote", "public/open-pr", "public/sync-back"]],
            ["versions", ["versions"]],
        ]);
        expect(changeNumbers(check.changes)).toEqual({
            "local/public/tag": 1,
            "local/file": 2,
            "public/promote": 3,
            "public/open-pr": 4,
            "public/sync-back": 5,
            versions: 6,
        });
    });

    it("draws the declared pipeline with a badge per change, by kind, dimmed while not taken", () => {
        const model = updateFlowModel(draft, check, "public", { "public/promote": false });
        const node = (key: string) => model.nodes.find((n) => n.key === key);
        expect(node("public/promote")).toMatchObject({ badge: 3, change: "removed", untaken: true });
        expect(node("public/open-pr")).toMatchObject({ badge: 4, change: "added", untaken: false });
        expect(node("public/sync-back")).toMatchObject({ badge: 5, change: "changed", untaken: true });
        expect(node("public/tag")).toMatchObject({ badge: 1, change: "changed" });
        expect(node("public/merge-pr").badge).toBeUndefined();
        const html = renderToStaticMarkup(<FlowDiagram model={model} />);
        expect(html).toContain('data-change="removed"');
        expect(html).toContain("var(--color-error)");
        expect(html).toContain("removed");
    });

    it("shows the reasons, the numbered changes and the choices to adjust", () => {
        const html = renderToStaticMarkup(
            <UpdateStep draft={draft} check={check} choices={{}} onChoose={() => {}}>
                <span>choices here</span>
            </UpdateStep>
        );
        expect(html).toContain("Your uncommitted edits are included");
        expect(html).toContain("master is protected: releases go through a pull request.");
        expect(html).toContain("Set up by MoltenTerm with template 1; this version writes template 2.");
        expect(html).toContain("Your uncommitted edits");
        expect(html).toContain("Your edits outside the release steps: ci, versions");
        expect(html).toContain("Include this edit");
        expect(html).toContain("yours, kept");
        expect(html).toMatch(/data-testid="update-take-public\/sync-back"(?![^>]*checked)/);
        expect(html).toMatch(/data-testid="update-take-public\/promote" checked=""/);
        expect(html).toContain('data-testid="setup-diagram"');
        expect(html).toContain("All the choices");
        expect(html).toContain("choices here");
        expect(updateReady(check)).toBe(true);
    });

    it("makes an up-to-date pipeline reviewable and says what opens the pull request", () => {
        const html = renderToStaticMarkup(
            <UpdateStep draft={draft} check={upToDate} choices={{}} onChoose={() => {}}>
                <span />
            </UpdateStep>
        );
        expect(html).toContain("Pipeline up to date");
        expect(html).toContain("set up before MoltenTerm kept track");
        expect(html).not.toContain('data-testid="update-changes"');
        expect(html).toContain('data-testid="setup-diagram"');
        expect(updateReady(upToDate)).toBe(false);
        const files = renderToStaticMarkup(<UpdateFiles check={upToDate} />);
        expect(files).toContain("Nothing changes");
    });

    it("reads in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            const html = renderToStaticMarkup(
                <UpdateStep draft={draft} check={upToDate} choices={{}} onChoose={() => {}}>
                    <span />
                </UpdateStep>
            );
            expect(html).toContain("Pipeline à jour");
            expect(html).toContain("Le pipeline déclaré");
            expect(html).toContain("Tous les choix");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });

    it("offers the update in the menu with its first reason", () => {
        const html = renderToStaticMarkup(
            <ReleaseSetupUpdateButton reason={{ code: "protected", detail: "master" }} onOpen={() => {}} />
        );
        expect(html).toContain("Update the release setup");
        expect(html).toContain("master is protected");
        expect(html).toContain("cursor-pointer");
    });
});
