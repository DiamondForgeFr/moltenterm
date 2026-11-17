// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration list while a group merge runs (#2318, acceptance 1 and 2): the "Suggested order" block, its button,
// its steps and the ranks of the cards are gone, the run's progress with "Cancel the merge" shows in their place, the
// Validate of the pull requests it concerns waits, and the block comes back, recomputed, once the run is cancelled or
// ended. The list is drawn with the run the way every panel of the project gets it: from the store its event fills.

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The window's global atoms are made when the app starts: here each one is an empty atom of its own, the settings an
// empty object, so the list reads its defaults.
vi.mock("@/app/store/global", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/store/global")>();
    const { atom } = await import("jotai");
    const made = new Map<string, unknown>([["settingsAtom", atom({})]]);
    const atoms = new Proxy(
        {},
        {
            get: (_target, key: string) => {
                if (!made.has(key)) {
                    made.set(key, atom(null));
                }
                return made.get(key);
            },
        }
    );
    const keyed = new Map<string, unknown>();
    const emptyAtomOf = (key: string) => {
        if (!keyed.has(key)) {
            keyed.set(key, atom(undefined));
        }
        return keyed.get(key);
    };
    return {
        ...actual,
        atoms,
        getSettingsKeyAtom: emptyAtomOf,
        getBlockMetaKeyAtom: (blockId: string, key: string) => emptyAtomOf(`${blockId}:${key}`),
    };
});

import { I18nModel } from "../i18n/i18n";
import { BatchRuns } from "./reviews-batch-client";
import type { BatchItem, BatchRun } from "./reviews-batch-model";
import { ForecastAnswers } from "./reviews-forecast-client";
import type { Forecast } from "./reviews-forecast-model";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import { OwnersFilter } from "./reviews-owners-filter";
import { ReviewsList } from "./reviews-view";

const Dir = "/shop";
const Base = "b".repeat(40);
const head = (n: number) => `h${n}`.padEnd(40, "0");

function pr(number: number): ReviewPr {
    return {
        number,
        title: `Synthetic change ${number}`,
        url: `https://github.com/acme/shop/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid: head(number),
        baseoid: Base,
        createdat: "2026-10-20T10:00:00Z",
        updatedat: "2026-10-24T10:00:00Z",
        merge: "clean",
        ci: { state: "success", success: 4, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
    };
}

// The group merge runs #31, #32 and #33; #34 is another pull request into the same base.
const Numbers = [31, 32, 33, 34];

function answerOf(listed: number[]): ReviewsAnswer {
    return {
        dir: Dir,
        state: "ok",
        repo: "acme/shop",
        url: "https://github.com/acme/shop",
        target: "develop",
        ready: listed.map(pr),
        drafts: [],
        merged: [],
        githubat: 1,
    };
}

// Pull requests that touch nothing in common: every one can merge now, in any order.
const forecast: Forecast = {
    dir: Dir,
    key: "k",
    state: "ready",
    baseoid: Base,
    method: "merge",
    uptodate: "notrequired",
    rows: Numbers.map((number) => ({ number, headoid: head(number), state: "simulated" as const, impacts: [] })),
};

function item(number: number, extra: Partial<BatchItem> = {}): BatchItem {
    return {
        number,
        headref: `feature/${number}-x`,
        headoid: head(number),
        valid: head(number),
        title: `Synthetic change ${number}`,
        method: "merge",
        source: "batch",
        state: "queued",
        ...extra,
    };
}

function run(extra: Partial<BatchRun> = {}): BatchRun {
    return {
        id: "r1",
        dir: Dir,
        repo: "acme/shop",
        base: "develop",
        state: "running",
        current: 0,
        items: [item(31, { state: "waitingchecks" }), item(32), item(33)],
        ciruns: 0,
        startedat: 1,
        ...extra,
    };
}

function list(listed = Numbers): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <ReviewsList dir={Dir} answer={answerOf(listed)} blockId="block-1" filter={new OwnersFilter("block-1")} />
        </Provider>
    );
}

function setRun(next: BatchRun, dir = Dir) {
    BatchRuns.getInstance().store(dir, "develop", next);
}

const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;
const block = 'data-testid="reviews-queue"';

describe("the Integration list while a group merge runs (#2318)", () => {
    beforeAll(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    beforeEach(() => {
        globalStore.set(BatchRuns.getInstance().runsAtom, {});
        globalStore.set(ForecastAnswers.getInstance().answersAtom, { [Dir]: forecast });
    });

    it("shows the suggested order, its button, its toggles and the ranks while no group merge runs", () => {
        const html = list();
        expect(html).toContain(block);
        expect(html).toContain("Merge these 4 in this order…");
        expect(count(html, /data-testid="reviews-queue-step-check"/g)).toBe(4);
        expect(count(html, /data-testid="reviews-order-rank"/g)).toBe(4);
        expect(html).not.toContain('data-testid="reviews-batch-banner"');
    });

    it("replaces them with the merge's progress and Cancel the merge once it runs (acceptance 1)", () => {
        setRun(run());
        const html = list();
        expect(html).not.toContain(block);
        expect(html).not.toContain('data-testid="reviews-queue-merge"');
        expect(html).not.toContain("in this order…");
        expect(html).not.toContain('data-testid="reviews-queue-step-check"');
        expect(html).not.toContain('data-testid="reviews-queue-step-go"');
        expect(html).not.toContain('data-testid="reviews-order-rank"');
        expect(html).toContain('data-testid="reviews-batch-banner"');
        expect(html).toMatch(/data-testid="reviews-batch-cancel"[^>]*>[^<]*Cancel the merge/);
        expect([...html.matchAll(/data-testid="reviews-batch-item" data-pr="(\d+)"/g)].map((m) => m[1])).toEqual([
            "31",
            "32",
            "33",
        ]);
    });

    it("takes the merge away from its pull requests, saying why, and leaves the other one into its base askable", () => {
        const idle = count(list(), /aria-disabled="true"/g);
        setRun(run());
        const html = list();
        expect(count(html, /aria-disabled="true"/g)).toBe(idle + 3);
        expect(count(html, /In the group merge that runs into develop: it merges in its turn\./g)).toBe(3);
        expect(html).not.toContain("A group merge into develop is running");
    });

    it("keeps it away while Cancel waits for the step under way", () => {
        setRun(run({ state: "cancelling", cancelasked: true }));
        const html = list();
        expect(html).not.toContain(block);
        expect(html).toContain("Cancelling…");
    });

    it("brings it back, recomputed, once the merge was cancelled (acceptance 2)", () => {
        const items = run().items.map((it) => ({ ...it, state: "withdrawn" as const, reason: "cancelled" as const }));
        setRun(run({ state: "cancelled", current: -1, items }));
        const html = list();
        expect(html).toContain(block);
        expect(html).toContain("Merge these 4 in this order…");
        expect(html).not.toContain("A group merge runs into develop");
        expect(html).toContain('data-testid="reviews-order-rank"');
    });

    it("brings it back once it ended only for the pull requests that remain to merge", () => {
        const items = [item(31, { state: "merged" }), item(32, { state: "merged" }), item(33, { state: "merged" })];
        setRun(run({ state: "done", current: -1, items }));
        expect(list([33, 34])).toContain("Merge these 2 in this order…");
        const alone = list([34]);
        expect(alone).not.toContain(block);
        expect(alone).toContain('data-testid="reviews-batch-banner"');
    });

    it("leaves the block to a queue of validated pull requests, and to the other projects", () => {
        setRun(run({ items: run().items.map((it) => ({ ...it, source: "validate" as const })) }));
        expect(list()).toContain(block);
        globalStore.set(BatchRuns.getInstance().runsAtom, {});
        setRun(run({ dir: "/other" }), "/other");
        expect(list()).toContain(block);
    });
});
