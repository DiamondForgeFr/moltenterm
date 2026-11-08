// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "Not a version label" (#1791): a label the release setup found is dismissed, recorded in versions.notlabels, so a
// false positive does not keep the setup update offered.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nModel, t } from "../i18n/i18n";
import {
    dismissedLabel,
    labelDismissed,
    labelKept,
    SetupDraft,
    SetupFacts,
    SetupLabel,
    SetupOptions,
    setupReasonText,
} from "./release-setup-model";
import { LabelsSection } from "./release-setup-reasons";

const options: SetupOptions = {
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
    labels: [{ path: "NOTES.md", line: 3, pattern: "Plugin version: {version}" }],
};

const notes: SetupLabel = {
    path: "NOTES.md",
    line: 3,
    text: "Plugin version: 0.1.0",
    version: "0.1.0",
    pattern: "Plugin version: {version}",
};

const draft = {
    facts: { currentversion: "1.0.0", labels: [notes] } as unknown as SetupFacts,
} as unknown as SetupDraft;

function render(o: SetupOptions): string {
    return renderToStaticMarkup(
        <LabelsSection draft={draft} options={o} onChange={() => {}} sectionClass="" titleClass="" />
    );
}

describe("Not a version label", () => {
    it("dismisses a label by its file and its text, and no longer keeps it", () => {
        const dismissed = dismissedLabel(options, notes, true);
        expect(dismissed.notlabels).toEqual([{ path: "NOTES.md", text: "Plugin version: 0.1.0" }]);
        expect(labelDismissed(dismissed, notes)).toBe(true);
        expect(labelKept(dismissed, notes)).toBe(false);
        // The same text further down the file is the same dismissal.
        expect(labelDismissed(dismissed, { ...notes, line: 9 })).toBe(true);
        const undone = dismissedLabel(dismissed, notes, false);
        expect(undone.notlabels).toEqual([]);
        expect(labelDismissed(undone, notes)).toBe(false);
    });

    it("offers the dismissal on each label, then its undo", () => {
        const html = render(options);
        expect(html).toContain("Not a version label");
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("line-through");
        const after = render(dismissedLabel(options, notes, true));
        expect(after).toContain("Undo");
        expect(after).toContain("line-through");
        expect(after).toContain("recorded in .molten/project.json");
    });

    it("says why the update records it, in English and in French", () => {
        expect(setupReasonText(t, { code: "notlabels", detail: "1" })).toBe(
            "Lines dismissed as not version labels: 1. They are not offered again."
        );
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(setupReasonText(t, { code: "notlabels", detail: "1" })).toContain("libellés de version (1)");
            expect(render(options)).toContain("Pas un libellé de version");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });

    it("names the step the template changed since the developer's choice (#1843)", () => {
        const reason = { code: "changedsince" as const, detail: "Commit, tag and push" };
        expect(setupReasonText(t, reason)).toBe(
            "MoltenTerm changed the step “Commit, tag and push” since your choice: keep yours or take its new version."
        );
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(setupReasonText(t, reason)).toContain(
                "MoltenTerm a changé l’étape « Commit, tag and push » depuis votre choix"
            );
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});
