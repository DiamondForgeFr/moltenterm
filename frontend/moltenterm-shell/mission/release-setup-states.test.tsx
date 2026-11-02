// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import type { SetupDraft } from "./release-setup-model";
import { ghProblemOf, SurveyStates } from "./release-setup-states";
import type { SetupSurvey } from "./release-setup-stepper";

// The empty and error states of step 1 (#1106): what happened, what still works, the next action.

const base: SetupSurvey = {
    apptype: "other",
    apptypeevidence: [],
    kind: "on-premise",
    tags: { read: true, prefix: "v", count: 0 },
    releases: { ongithub: false, read: false, count: 0 },
    publish: [],
    changelogs: [],
    pipeline: "none",
    missing: ["rc", "public"],
    ships: false,
    recommended: "describe",
    base: "",
    git: true,
    remote: true,
    empty: false,
    agent: "claude",
    agentname: "Claude Code",
};

const draft = { facts: { branches: { trunk: "develop", release: "master" } }, pr: { target: "develop" } } as SetupDraft;

function render(survey: SetupSurvey, ghDismissed = false) {
    return renderToStaticMarkup(
        <SurveyStates
            survey={survey}
            draft={draft}
            ghDismissed={ghDismissed}
            onDescribe={() => {}}
            onTemplate={() => {}}
            onReadAgain={() => {}}
            onGoOn={() => {}}
            onOpenFile={() => {}}
        />
    );
}

describe("step 1's empty and error states (#1106)", () => {
    it("shows nothing for a repository that reads well", () => {
        expect(render(base)).not.toContain("setup-state-");
    });

    it("offers to describe the pipeline or use a template when there is nothing to read", () => {
        const html = render({ ...base, empty: true });
        expect(html).toContain("Nothing to read yet");
        expect(html).toContain("No build file, no workflow, no tag.");
        expect(html).toContain('data-testid="setup-empty-describe"');
        expect(html).toContain("Use a template");
    });

    it("says GitHub could not be reached, why, and lets the developer go on", () => {
        const signedOut = render({
            ...base,
            releases: { ongithub: true, read: false, count: 0, problem: "signedout", error: "gh auth login" },
        });
        expect(signedOut).toContain("GitHub could not be reached");
        expect(signedOut).toContain("The protection of master is unknown");
        expect(signedOut).toContain("run gh auth login in a terminal");
        expect(signedOut).toContain('data-testid="setup-read-again"');
        expect(signedOut).toContain('data-testid="setup-go-on"');
        const missing = render({ ...base, releases: { ongithub: true, read: false, count: 0, problem: "missing" } });
        expect(missing).toContain("gh is not installed on this computer");
        const failed = render({
            ...base,
            releases: { ongithub: true, read: false, count: 0, problem: "failed", error: "HTTP 502" },
        });
        expect(failed).toContain("gh says: HTTP 502");
        expect(
            render({ ...base, releases: { ongithub: true, read: false, count: 0, problem: "failed" } }, true)
        ).not.toContain("setup-state-github");
    });

    it("reads gh's problem from the protection when the releases answered", () => {
        const withProtection = {
            ...draft,
            facts: { ...draft.facts, protection: { problem: "signedout", error: "401" } },
        } as SetupDraft;
        expect(ghProblemOf({ ...base, releases: { ongithub: true, read: true, count: 1 } }, withProtection)).toEqual({
            problem: "signedout",
            error: "401",
        });
        expect(ghProblemOf(base, withProtection)).toBeNull();
    });

    it("shows an invalid pipeline's errors, with the file to open", () => {
        const html = render({
            ...base,
            pipeline: "invalid",
            pipelineerrors: ['release.public[3]: "run" and "manual" are both set'],
        });
        expect(html).toContain(".molten/project.json is not valid");
        expect(html).toContain("release.public[3]: &quot;run&quot; and &quot;manual&quot; are both set");
        expect(html).toContain("Open the file");
        expect(html).not.toContain("Nothing to read yet");
    });

    it("says when there is no git repository, or no origin", () => {
        expect(render({ ...base, git: false })).toContain("Not a git repository yet");
        const noRemote = render({ ...base, remote: false });
        expect(noRemote).toContain("No origin remote");
        expect(noRemote).toContain("Copy the patch");
    });

    it("reads in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            const html = render({
                ...base,
                empty: true,
                releases: { ongithub: true, read: false, count: 0, problem: "signedout" },
            });
            expect(html).toContain("Rien à lire pour l’instant");
            expect(html).toContain("Utiliser un modèle");
            expect(html).toContain("GitHub n’a pas pu être joint");
            expect(html).toContain("MoltenTerm ne demande jamais de jeton");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});
