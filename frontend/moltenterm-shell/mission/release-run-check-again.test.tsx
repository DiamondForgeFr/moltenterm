// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManualCheckFailure } from "./mission-model";
import { PendingGate, PendingLock } from "./pending-action";
import { PhaseAction } from "./release-run";
import { checkStep, ReleasePanelActions, UncoveredNote, UnprovedWarning } from "./release-run-panel";

// The coverage warning of a changelog step checks again, and says why each change is listed (#1717).

function gateLock(): PendingLock {
    const gate = new PendingGate(() => {});
    return { pending: "", run: (key, fn) => gate.run(key, fn, false) };
}

const manualAction: PhaseAction = { kind: "step", step: "changelog-en", label: "Mark as done: Write it" };

const failureOf = (tickets: number[]): ManualCheckFailure => ({
    path: "docs/changelog.md",
    contains: "1.1.0",
    dir: "/r/app-release",
    version: "1.1.0",
    since: "v1.0.1",
    uncovered: tickets.map((n) => ({
        ticket: n,
        text: `change ${n}`,
        type: "feat",
        subject: `feat(#${n}): change ${n}`,
    })),
});

const noop = () => {};

describe("checking a changelog section again (#1717)", () => {
    it("offers Check again beside the confirmation, and says where the file was read", () => {
        const html = renderToStaticMarkup(
            <UnprovedWarning
                failure={failureOf([1011])}
                locked={false}
                busy={null}
                busyLabel="Marking"
                onCancel={noop}
                onCheckAgain={noop}
                onForce={noop}
            />
        );
        expect(html).toContain('data-testid="release-run-check-again"');
        expect(html).toContain("Check again");
        expect(html).toContain("Mark as done anyway");
        expect(html).toContain("Read in /r/app-release.");
    });

    it("runs the check again without force and shows the new list, then nothing once the section is complete", async () => {
        let missing = [1011, 1061];
        const sent: PhaseAction[] = [];
        const actions: ReleasePanelActions = {
            loadNotes: async () => "",
            saveNotes: async () => {},
            run: async (action, onUnproved) => {
                sent.push(action);
                if (action.kind === "step" && !action.force && missing.length > 0) {
                    onUnproved(failureOf(missing));
                    return false;
                }
                return true;
            },
        };
        const lock = gateLock();
        const first = await checkStep(lock, "action:x", actions, manualAction, false, null);
        expect(first.unproved.uncovered.map((i) => i.ticket)).toEqual([1011, 1061]);

        missing = [1061];
        const again = await checkStep(lock, "action:x", actions, manualAction, false, first.unproved);
        expect(again).toEqual({ unproved: failureOf([1061]), notice: null, done: false });

        missing = [];
        const done = await checkStep(lock, "action:x", actions, manualAction, false, again.unproved);
        expect(done).toEqual({ unproved: null, notice: null, done: true });
        expect(sent.map((a) => a.kind === "step" && !!a.force)).toEqual([false, false, false]);
    });

    it("keeps the list shown when another action of the card is under way", async () => {
        const current = failureOf([1011]);
        const busyLock: PendingLock = { pending: "action:other", run: async () => false };
        const actions: ReleasePanelActions = {
            loadNotes: async () => "",
            saveNotes: async () => {},
            run: async () => true,
        };
        const state = await checkStep(busyLock, "action:x", actions, manualAction, false, current);
        expect(state.unproved).toBe(current);
        expect(state.notice).toBe("mc.releaseRun.actionRefused");
    });
});

describe("why a change is listed (#1717)", () => {
    it("names its commit, its type and the release it counts from", () => {
        const html = renderToStaticMarkup(<UncoveredNote failure={failureOf([1011])} />);
        expect(html).toContain("#1011");
        expect(html).toContain(
            "feat commit “feat(#1011): change 1011” since v1.0.1, cited neither in this section nor in an earlier one."
        );
    });

    it("says nothing more for an item without its commit", () => {
        const failure = { ...failureOf([]), uncovered: [{ ticket: 7, text: "older server" }] };
        expect(renderToStaticMarkup(<UncoveredNote failure={failure} />)).not.toContain("release-run-uncovered-why");
    });
});
