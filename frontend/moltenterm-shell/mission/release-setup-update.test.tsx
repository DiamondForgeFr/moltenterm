// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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

import { ReleaseSetupUpdateButton } from "./release-menu";
import { changeGroups, changeTaken, SetupCheck } from "./release-setup-model";
import { UpdateBody } from "./release-setup-update";

const check: SetupCheck = {
    state: "update",
    reasons: [{ code: "protected", detail: "master" }, { code: "labels", detail: "3" }, { code: "template" }],
    changes: [
        {
            key: "rc/promote",
            channel: "rc",
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
    recordtemplate: 0,
    template: 2,
    releasebranch: "master",
    current: "{\n}\n",
    base: "b",
    proposed: '{\n    "release": {}\n}\n',
    signature: "s",
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
        subject: "chore(release): update the release setup",
        tickettitle: "Update the release setup",
        uncommitted: false,
        included: false,
        localbase: "l",
    },
};

describe("release setup update (#1086)", () => {
    it("keeps a customised change unless the developer ticks it", () => {
        const custom = check.changes[2];
        expect(changeTaken(custom, {})).toBe(false);
        expect(changeTaken(custom, { "public/sync-back": true })).toBe(true);
        expect(changeTaken(check.changes[0], { "rc/promote": false })).toBe(false);
        expect(changeTaken(check.changes[0], {})).toBe(true);
    });

    it("groups the changes by channel, the version files last", () => {
        expect(changeGroups(check.changes).map((g) => [g.group, g.changes.map((c) => c.key)])).toEqual([
            ["rc", ["rc/promote"]],
            ["public", ["public/open-pr", "public/sync-back"]],
            ["versions", ["versions"]],
        ]);
        expect(changeGroups([])).toEqual([]);
    });

    it("lists the reasons, the changes with their choice and the file's diff", () => {
        const html = renderToStaticMarkup(<UpdateBody check={check} choices={{}} onChoose={() => {}} />);
        expect(html).toContain("master is protected: releases go through a pull request.");
        expect(html).toContain("Version labels found outside the version files: 3.");
        expect(html).toContain("set up before MoltenTerm kept track");
        expect(html).toContain("Release candidate");
        expect(html).toContain("Public release");
        expect(html).toContain("You changed this step: your version is kept unless you tick the new one.");
        expect(html).toContain("Use the new version");
        expect(html).toMatch(/data-testid="update-take-public\/sync-back"(?![^>]*checked)/);
        expect(html).toMatch(/data-testid="update-take-rc\/promote" checked=""/);
        expect(html).toContain('data-testid="setup-diff"');
    });

    it("offers the update in the menu with its first reason", () => {
        const html = renderToStaticMarkup(<ReleaseSetupUpdateButton reason={check.reasons[0]} onOpen={() => {}} />);
        expect(html).toContain("Update the release setup");
        expect(html).toContain("master is protected");
        expect(html).toContain("cursor-pointer");
    });
});
