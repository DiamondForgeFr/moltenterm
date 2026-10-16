// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control words wavesrv's refusals and results from their codes (#656).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { cleanErrorLines } from "./branch-cleanup";
import { describeOutcome } from "./ci-jobs-model";
import { syncBlocker } from "./dep-sync-model";
import { DependencyState } from "./group-model";

const dep: DependencyState = {
    index: 0,
    project: "lib",
    paths: [],
    output: [],
    sync: "make sync",
    state: "branchnotfound",
    problem: "lib has no branch main, local or on origin",
    problemtext: { code: "mission.deps.noBranch", vars: { name: "lib", branch: "main" } },
} as DependencyState;

describe("Mission Control's server sentences in French", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("words a route's refusal", () => {
        const wired = 'uimsg:{"code":"mission.run.stillRunning","vars":{"title":"Build"}}\nBuild is still running';
        expect(serverErrorText(new Error(wired))).toBe("Build est encore en cours.");
    });

    it("words the branches the cleaning kept, with the list's reason", () => {
        const lines = cleanErrorLines(
            {
                deleted: [],
                failed: 2,
                errors: ["origin/x: kept (open-pr)", "y: boom"],
                errorstext: [
                    { code: "mission.branches.kept", vars: { branch: "origin/x", reason: "open-pr", pr: "0" } },
                    { code: "mission.branches.deleteFailed", vars: { branch: "y", detail: "boom" } },
                ],
            },
            "develop"
        );
        expect(lines[0]).toMatch(/^origin\/x : gardée \(.+\)$/);
        expect(lines[0]).not.toContain("open-pr");
        expect(lines[1]).toBe("y : boom");
    });

    it("words a dependency's problem and a refused description", () => {
        expect(syncBlocker(dep)).toBe("lib n'a pas de branche main, ni locale ni sur origin.");
        expect(
            describeOutcome(
                { sent: false, message: "English", messagetext: { code: "mission.jobs.cannotType" } },
                "Claude"
            ).text
        ).toBe("MoltenTerm ne peut pas encore taper dans les terminaux : rien n'a été envoyé.");
    });

    it("keeps the English of a result without a code", () => {
        expect(cleanErrorLines({ deleted: [], failed: 1, errors: ["plain"] }, "develop")).toEqual(["plain"]);
    });
});
