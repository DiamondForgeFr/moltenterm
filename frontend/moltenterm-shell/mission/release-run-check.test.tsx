// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManualCheckFailure, PipelineReleaseStep } from "./mission-model";
import { PendingGate, PendingLock } from "./pending-action";
import { PhaseAction, ReleaseFacts, releaseRun } from "./release-run";
import { ReleasePanelActions, ReleaseRunPanel, sendAction } from "./release-run-panel";

// A manual step's check and the formatter's word on the release card (#1095).

const steps: PipelineReleaseStep[] = [
    { id: "prepare", title: "Prepare", phase: "prepare", run: "molten release prepare {tag} --pr" },
    { id: "changelog-en", title: "Write the [{version}] section", phase: "cut", manual: "Write it.", run: undefined },
    {
        id: "open-pr",
        title: "Open the pull request",
        phase: "cut",
        confirm: "Pushes rc-{version}.",
        run: "molten release open-pr {tag}",
    },
];

function facts(extra: Partial<ReleaseFacts> = {}): ReleaseFacts {
    return {
        session: { tag: "v1.1.0", version: "1.1.0", channel: "public", startedat: 1 },
        tag: "v1.1.0",
        version: "1.1.0",
        channel: "public",
        tagexists: false,
        steps: {},
        preparation: { runid: "p", state: "success", running: false, exit: 0, tail: [], phases: [] },
        runs: [],
        jobs: [],
        ontrunk: false,
        ...extra,
    };
}

function gateLock(): PendingLock {
    const gate = new PendingGate(() => {});
    return { pending: "", run: (key, fn) => gate.run(key, fn, false) };
}

const noNotes = { loadNotes: async () => "", saveNotes: async () => {} };

const manualAction: PhaseAction = { kind: "step", step: "changelog-en", label: "Mark as done: Write it" };

const failure: ManualCheckFailure = { path: "docs/changelog.md", contains: "## [1.1.0]", dir: "/r/app-release" };

describe("a manual step's check (FR-MC-037, #1095)", () => {
    it("comes back asked with what is missing, then is sent again confirmed anyway", async () => {
        const sent: PhaseAction[] = [];
        const actions: ReleasePanelActions = {
            ...noNotes,
            run: async (action, onUnproved) => {
                sent.push(action);
                if (action.kind === "step" && !action.force) {
                    onUnproved(failure);
                    return false;
                }
                return true;
            },
        };
        const lock = gateLock();
        const first = await sendAction(lock, "action:x", actions, manualAction);
        expect(first).toEqual({ outcome: "asked", failure });
        const second = await sendAction(lock, "action:x", actions, manualAction, true);
        expect(second).toEqual({ outcome: "done", failure: null });
        expect(sent.map((a) => a.kind === "step" && !!a.force)).toEqual([false, true]);
    });

    it("keeps the trust's asked outcome apart: no failure is said", async () => {
        const actions: ReleasePanelActions = { ...noNotes, run: async () => false };
        expect(await sendAction(gateLock(), "action:x", actions, manualAction)).toEqual({
            outcome: "asked",
            failure: null,
        });
    });
});

describe("the formatter's word before the commit (#1095)", () => {
    const render = (f: ReleaseFacts) =>
        renderToStaticMarkup(
            <ReleaseRunPanel
                run={releaseRun(f, steps)}
                jobs={[]}
                actions={{ ...noNotes, run: async () => true }}
                lock={{ pending: "", run: async () => true }}
            />
        );
    const changelogDone = { "changelog-en": facts().preparation };

    it("says when the formatter failed, with the command to run, in the cut", () => {
        const command = "node_modules/.bin/prettier --write --ignore-unknown -- 'releases/v1.1.0.md'";
        const f = facts({ steps: changelogDone, format: { state: "failed", command, step: "@preparation" } });
        expect(releaseRun(f, steps).unformatted?.state).toBe("failed");
        const html = render(f);
        expect(html).toContain('data-testid="release-run-unformatted"');
        expect(html).toContain("not formatted the way the project&#x27;s CI checks");
        expect(html).toContain("releases/v1.1.0.md");
    });

    it("says when no formatter was found", () => {
        const html = render(facts({ steps: changelogDone, format: { state: "none", step: "@preparation" } }));
        expect(html).toContain("No formatter was found");
    });

    it("says nothing once formatted, or once the tag is pushed", () => {
        const formatted = facts({ format: { state: "formatted", formatter: "prettier", step: "open-pr" } });
        expect(releaseRun(formatted, steps).unformatted).toBeUndefined();
        expect(render(formatted)).not.toContain("release-run-unformatted");
        const tagged = facts({ tagexists: true, format: { state: "failed", command: "x", step: "open-pr" } });
        expect(releaseRun(tagged, steps).unformatted).toBeUndefined();
    });
});
