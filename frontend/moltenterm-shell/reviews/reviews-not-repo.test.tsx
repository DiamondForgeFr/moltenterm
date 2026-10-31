// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Integration panel in a project folder without git (#1650, FR-REV-001 AC15): a calm explanation in its own words,
// one call to action, a confirmation that names the folder. #1671: the other git panels use the same words, and a view
// holding several of them keeps one call to action.

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { I18nModel, t } from "../i18n/i18n";
import { GitProblemState } from "../mission/mission-frame";
import { GitPanel, notRepoGroupKey, notRepoPanelsAtom } from "../mission/not-repo-carrier";
import { PanelBlockIdContext } from "../view360/offcarpet-model";
import { reviewsNotRepoText } from "./reviews-model";

const NotRepoError = "git rev-parse --git-dir: fatal: not a git repository (or any of the parent directories): .git";
const Project = { workspace: { oid: "ws" } as Workspace, dir: "/home/me/notes", facts: null };

function stateHtml(gitPanel: GitPanel, blockId?: string): string {
    const state = (
        <GitProblemState
            project={Project}
            gitError={NotRepoError}
            refresh={() => {}}
            gitPanel={gitPanel}
            notRepoText={gitPanel === "integration" ? reviewsNotRepoText() : undefined}
        />
    );
    if (blockId == null) {
        return renderToStaticMarkup(state);
    }
    return renderToStaticMarkup(<PanelBlockIdContext.Provider value={blockId}>{state}</PanelBlockIdContext.Provider>);
}

describe("Integration panel without git (#1650)", () => {
    afterEach(() => globalStore.set(notRepoPanelsAtom, {}));

    it("explains why the panel needs git and offers to start tracking", () => {
        const html = stateHtml("integration");
        expect(html).toContain('data-testid="mission-not-git"');
        expect(html).toContain("This folder does not use git yet");
        expect(html).toContain("The Integration panel follows the project&#x27;s changes with git");
        expect(html).toContain("Start tracking with git");
        expect(html).not.toContain("fatal: not a git repository");
        expect(html.match(/molten-btn\b(?!-)/g)).toHaveLength(1);
    });

    it("names the folder in the confirmation, with Not now to leave it as it is", () => {
        expect(t("mc.frame.gitInitTitle", { name: "notes" })).toBe("Start tracking notes with git?");
        expect(t("mc.frame.initGit")).toBe("Start tracking with git");
        expect(t("mc.frame.notNow")).toBe("Not now");
    });

    it("gives the other git panels the same wording, without git's output (#1671)", () => {
        const html = stateHtml("project");
        expect(html).toContain("This folder does not use git yet");
        expect(html).toContain("Start tracking with git");
        expect(html).not.toContain("Initialize git");
        expect(html).not.toContain("fatal: not a git repository");
    });

    it("leaves one call to action in a view holding several git panels (#1671)", () => {
        globalStore.set(notRepoPanelsAtom, {
            [notRepoGroupKey(undefined, Project.dir)]: { "block-int": "integration", "block-proj": "project" },
        });
        const carrier = stateHtml("integration", "block-int");
        const pointer = stateHtml("project", "block-proj");
        expect(carrier).toContain('data-testid="mission-not-git"');
        expect(carrier.match(/molten-btn\b(?!-)/g)).toHaveLength(1);
        expect(pointer).toContain('data-testid="mission-not-git-pointer"');
        expect(pointer).toContain("This folder does not use git yet");
        expect(pointer).toContain("Start tracking it with git from the Integration panel in this view.");
        expect(pointer).not.toContain("<button");
    });

    it("lets the Project panel carry it when no Integration panel shows that folder (#1671)", () => {
        globalStore.set(notRepoPanelsAtom, {
            [notRepoGroupKey(undefined, Project.dir)]: { "block-proj": "project", "block-ci": "cicd" },
            [notRepoGroupKey(undefined, "/elsewhere")]: { "block-int": "integration" },
        });
        expect(stateHtml("project", "block-proj")).toContain('data-testid="mission-not-git"');
        expect(stateHtml("cicd", "block-ci")).toContain("from the Project panel in this view");
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

        it("says it in French", () => {
            expect(t("mc.frame.notRepoTitle")).toBe("Ce dossier n'utilise pas encore git");
            expect(t("mc.frame.gitInitTitle", { name: "notes" })).toMatch(/^Suivre notes avec git\s\?$/);
            expect(t("mc.frame.initGitHere")).toBe("Suivre avec git");
            expect(t("mc.frame.notNow")).toBe("Pas maintenant");
        });
    });
});
