// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PendingLock, PendingLockContext } from "./pending-action";
import { ReleaseFailureActions } from "./release-resolve";
import { Phase, ReleaseFacts, releaseRun } from "./release-run";
import { ReleasePanelActions, ReleaseRunPanel } from "./release-run-panel";

const actions: ReleasePanelActions = {
    run: async () => true,
    loadNotes: async () => "",
    saveNotes: async () => {},
};

const facts: ReleaseFacts = {
    tag: "v1.0.0-6",
    version: "1.0.0-6",
    channel: "rc",
    tagexists: false,
    steps: {},
    preparation: { runid: "p1", state: "failure", running: false, tail: ["boom"], phases: ["promote"] },
    runs: [],
    jobs: [],
    ontrunk: false,
};

const steps = [{ id: "promote", title: "Promote develop", run: "molten release promote", phase: "prepare" as const }];

const lockAt = (pending: string): PendingLock => ({ pending, run: async () => false });

function render(pending: string): string {
    const run = releaseRun(facts, steps as any);
    return renderToStaticMarkup(
        <ReleaseRunPanel run={run} jobs={[]} actions={actions} onAbandon={async () => {}} lock={lockAt(pending)} />
    );
}

// The opening tag of the element with this test id.
function tagOf(html: string, testId: string): string {
    const at = html.indexOf(`data-testid="${testId}"`);
    expect(at).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

describe("the release card's pending actions (#952)", () => {
    it("offers its actions when nothing is pending", () => {
        const html = render("");
        expect(tagOf(html, "release-run-action")).not.toContain('disabled=""');
        expect(html).toContain("Retry the preparation");
        expect(html).not.toContain("df-domino-loader");
        expect(tagOf(html, "release-run-abandon")).not.toContain('disabled=""');
    });

    it("shows the clicked action with the domino loader and a short label, every other action disabled", () => {
        const html = render("action:Retry the preparation");
        const button = tagOf(html, "release-run-action");
        expect(button).toContain('disabled=""');
        expect(button).toContain('aria-busy="true"');
        expect(html).toContain("df-domino-loader");
        expect(html).toContain("Preparing…");
        expect(html).not.toContain("Retry the preparation");
        expect(tagOf(html, "release-run-abandon")).toContain('disabled=""');
    });

    it("disables the card's actions while another one of them is pending", () => {
        const html = render("resolve:background");
        expect(tagOf(html, "release-run-action")).toContain('disabled=""');
        expect(tagOf(html, "release-run-action")).not.toContain('aria-busy="true"');
        expect(html).toContain("Retry the preparation");
    });

    it("words the pending label of each kind of action", () => {
        const run = releaseRun(facts, steps as any);
        expect(run.phases[0].action).toMatchObject({ kind: "prepare", busy: "Preparing…" });
        const failedStep = releaseRun(
            {
                ...facts,
                tagexists: true,
                preparation: { ...facts.preparation, state: "success" },
                steps: { "sync-back": { runid: "s1", state: "failure", running: false, tail: ["x"], phases: [] } },
                release: { tagName: "v1.0.0-6", isDraft: false, isPrerelease: true, url: "https://x" },
            },
            [...steps, { id: "sync-back", title: "Sync back", run: "x", phase: "back" }] as any
        );
        expect(failedStep.phases[4].action).toMatchObject({ kind: "step", busy: "Starting Sync back…" });
    });

    it("shares the card's lock with a failed step's ways out", () => {
        const phase: Phase = {
            id: "prepare",
            title: "Prepare",
            status: "failed",
            expect: "",
            links: [],
            action: { kind: "prepare", label: "Retry the preparation" },
            failure: { step: "Promote develop", runid: "p1", runs: [] },
        };
        const html = renderToStaticMarkup(
            <PendingLockContext.Provider value={lockAt("resolve:background")}>
                <ReleaseFailureActions
                    phase={phase}
                    actions={{ rerunRuns: async () => {}, resolve: async () => ({ result: null, tab: "" }) }}
                />
            </PendingLockContext.Provider>
        );
        expect(tagOf(html, "release-run-analyze")).toContain('disabled=""');
        expect(tagOf(html, "release-run-together")).toContain('disabled=""');
        expect(html).toContain("df-domino-loader");
        const other = renderToStaticMarkup(
            <PendingLockContext.Provider value={lockAt("abandon")}>
                <ReleaseFailureActions
                    phase={phase}
                    actions={{ rerunRuns: async () => {}, resolve: async () => ({ result: null, tab: "" }) }}
                />
            </PendingLockContext.Provider>
        );
        expect(tagOf(other, "release-run-analyze")).toContain('disabled=""');
        expect(other).not.toContain("df-domino-loader");
    });
});
