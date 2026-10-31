// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Integration panel in a project folder without git (#1650, FR-REV-001 AC15): a calm explanation in its own words,
// one call to action, a confirmation that names the folder; the Project panel keeps its words.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { GitProblemState } from "../mission/mission-frame";
import { reviewsNotRepoText } from "./reviews-model";

const NotRepoError = "git rev-parse --git-dir: fatal: not a git repository (or any of the parent directories): .git";
const Project = { workspace: { oid: "ws" } as Workspace, dir: "/home/me/notes", facts: null };

function stateHtml(withText: boolean): string {
    return renderToStaticMarkup(
        <GitProblemState
            project={Project}
            gitError={NotRepoError}
            refresh={() => {}}
            notRepoText={withText ? reviewsNotRepoText(Project.dir) : undefined}
        />
    );
}

describe("Integration panel without git (#1650)", () => {
    it("explains why the panel needs git and offers to start tracking", () => {
        const html = stateHtml(true);
        expect(html).toContain('data-testid="mission-not-git"');
        expect(html).toContain("This folder does not use git yet");
        expect(html).toContain("The Integration panel follows the project&#x27;s changes with git");
        expect(html).toContain("Start tracking with git");
        expect(html).not.toContain("Project panel");
        expect(html).not.toContain("fatal: not a git repository");
        expect(html.match(/molten-btn\b(?!-)/g)).toHaveLength(1);
    });

    it("names the folder in the confirmation, with Not now to leave it as it is", () => {
        const text = reviewsNotRepoText("/home/me/notes/");
        expect(text.confirmTitle).toBe("Start tracking notes with git?");
        expect(text.confirm).toBe("Start tracking with git");
        expect(text.cancel).toBe("Not now");
    });

    it("keeps the Project panel's words and git's output under Details without them", () => {
        const html = stateHtml(false);
        expect(html).toContain("This folder is not a git repository");
        expect(html).toContain("Initialize git here");
        expect(html).toContain("fatal: not a git repository");
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

        it("says it in French", () => {
            const text = reviewsNotRepoText("/home/me/notes");
            expect(text.title).toBe("Ce dossier n'utilise pas encore git");
            expect(text.confirmTitle).toBe("Suivre notes avec git ?");
            expect(text.cancel).toBe("Pas maintenant");
        });
    });
});
