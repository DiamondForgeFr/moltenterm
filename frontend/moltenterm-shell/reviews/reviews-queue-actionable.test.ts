// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// #1211 (FR-REV-024): the recommended order ranks only the PRs the developer can merge now (CI green, no conflict
// with the target, no agent working on them); every other queued PR says on its card why to wait; the block shows
// only from two mergeable PRs (developer decision 2026-10-28): none with 0 or 1, and no sentence in its place.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import type { Forecast, ForecastRow } from "./reviews-forecast-model";
import type { ReviewPr } from "./reviews-model";
import {
    BusyOf,
    mergeQueue,
    queueCanMerge,
    queueChosen,
    queueMergeable,
    queueRanks,
    queueShown,
    queueWait,
} from "./reviews-queue-model";

const Base = "b".repeat(40);
const head = (n: number) => `h${n}`.padEnd(40, "0");

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
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
        ...extra,
    };
}

const Running = { state: "pending", success: 2, failure: 0, pending: 2, checks: [] } as ReviewPr["ci"];

function impact(number: number, paths: string[]) {
    return { number, headoid: head(number), paths, pathcount: paths.length };
}

function row(number: number, impacts: ReturnType<typeof impact>[]): ForecastRow {
    return { number, headoid: head(number), state: "simulated", impacts };
}

// #1301 and #1304 can merge now; #1302's CI runs; Salomé works on #1303; #1305's CI runs and it shares
// src/theme.ts with #1301.
const Green1 = pr(1301);
const Ci = pr(1302, { ci: Running });
const Busy = pr(1303);
const Green2 = pr(1304);
const After = pr(1305, { ci: Running });
const Forecast1211: Forecast = {
    dir: "/shop",
    key: "k",
    state: "ready",
    baseoid: Base,
    method: "merge",
    uptodate: "notrequired",
    rows: [
        row(1301, [impact(1305, ["src/theme.ts"])]),
        row(1302, []),
        row(1303, []),
        row(1304, []),
        row(1305, [impact(1301, ["src/theme.ts"])]),
    ],
};
const Salome: BusyOf = (n) => (n === 1303 ? "Salomé" : null);

function queueOf(prs: ReviewPr[]) {
    return mergeQueue(Forecast1211, prs, prs, [], Salome);
}

describe("recommended order: only what can merge now (#1211)", () => {
    let locale: string;
    beforeAll(() => {
        locale = I18nModel.getInstance().getLocale();
        I18nModel.getInstance().setLanguageSetting("en");
    });
    afterAll(() => I18nModel.getInstance().setLanguageSetting(locale));

    it("knows what the developer can merge now: CI green, no conflict, no agent", () => {
        expect(queueMergeable(Green1, Salome)).toBe(true);
        expect(queueMergeable(pr(1, { merge: "behind" }))).toBe(true);
        expect(queueMergeable(Busy, Salome)).toBe(false);
        expect(queueMergeable(Ci)).toBe(false);
        expect(queueMergeable(pr(2, { merge: "conflicts" }))).toBe(false);
        expect(
            queueMergeable(pr(3, { ci: { state: "failure", success: 1, failure: 1, pending: 0, checks: [] } }))
        ).toBe(false);
        expect(queueMergeable(pr(4, { draft: true }))).toBe(false);
        expect(queueMergeable(pr(5, { merge: "blocked" }))).toBe(false);
    });

    it("0 mergeable: no block, no rank, and each card still knows why it waits", () => {
        const queue = queueOf([Ci, Busy]);
        expect(queue.steps).toEqual([]);
        expect(queueShown(queue)).toBe(false);
        expect(queueRanks(queue)).toEqual({});
        expect(wordPhrase(queueWait(queue, 1302))).toBe("Wait for its CI");
        const checking = queueOf([pr(1306, { merge: "unknown" }), Busy]);
        expect(wordPhrase(queueWait(checking, 1306))).toBe("Wait for GitHub to check the merge");
        expect(wordPhrase(queueWait(queue, 1303))).toBe("Wait for Salomé, still working on it");
    });

    it("1 mergeable and two waiting: no block either (nothing to order)", () => {
        const queue = queueOf([Green1, Ci, Busy]);
        expect(queueChosen(queue)).toEqual([1301]);
        expect(queueShown(queue)).toBe(false);
        expect(queue.waits.map((w) => [w.number, w.reason])).toEqual([
            [1302, "ci"],
            [1303, "agent"],
        ]);
    });

    it("2 mergeable: the block ranks only them, the others wait with their reason", () => {
        const queue = queueOf([Green1, Ci, Busy, Green2, After]);
        expect(queueShown(queue)).toBe(true);
        expect(Object.keys(queueRanks(queue)).map(Number).sort()).toEqual([1301, 1304]);
        expect(queueCanMerge(queue)).toBe(true);
        expect(queueChosen(queue)).toHaveLength(2);
        expect(queueWait(queue, 1301)).toBeNull();
        expect(wordPhrase(queueWait(queue, 1303))).toBe("Wait for Salomé, still working on it");
        expect(wordPhrase(queueWait(queue, 1305))).toBe("Wait for #1301: same files, saves a rebase");
        expect(queue.waits.map((w) => w.number)).toEqual([1302, 1303, 1305]);
    });

    it("an agent without a name, and the French words", () => {
        const queue = mergeQueue(Forecast1211, [Green1, Green2, Busy, Ci], [Green1, Green2, Busy, Ci], [], (n) =>
            n === 1303 ? "" : null
        );
        expect(wordPhrase(queueWait(queue, 1303))).toBe("Wait for the agent still working on it");
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            expect(wordPhrase(queueWait(queue, 1303))).toBe("Attendre l'agent qui y travaille encore");
            const after = queueOf([Green1, Green2, After]);
            expect(wordPhrase(queueWait(after, 1305))).toBe("Attendre #1301 : mêmes fichiers, un rebase évité");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});
