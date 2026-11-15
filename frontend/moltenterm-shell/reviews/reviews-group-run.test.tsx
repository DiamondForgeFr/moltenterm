// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A group merge that runs (#2318, FR-REV-026 AC15): the suggested order is not shown, its progress with "Cancel the
// merge" takes its place, its own PRs have no merge action, the merge of another PR into its base asks first (#943),
// and everything comes back once it stopped.

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { I18nModel, t } from "../i18n/i18n";
import { phrase, wordPhrase } from "../i18n/phrase";
import { BatchBanner } from "./reviews-batch";
import { BatchRuns } from "./reviews-batch-client";
import {
    batchCancelKeys,
    BatchItem,
    BatchRun,
    batchShownSteps,
    groupHoldOf,
    groupMergeRunning,
} from "./reviews-batch-model";
import { confirmKeysOf } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import { MergeQueue, queueOrderShown } from "./reviews-queue-model";
import { CardContext, cardStates } from "./reviews-sections-model";
import type { UpcomingAnswer } from "./reviews-upcoming-model";

const Start = Date.parse("2026-11-09T10:00:00Z");

function item(number: number, extra: Partial<BatchItem> = {}): BatchItem {
    return {
        number,
        headref: `feature/${number}-x`,
        headoid: "a".repeat(40),
        valid: "a".repeat(40),
        title: `Synthetic change ${number}`,
        method: "merge",
        source: "batch",
        state: "queued",
        ...extra,
    };
}

function run(items: BatchItem[], extra: Partial<BatchRun> = {}): BatchRun {
    return {
        id: "r1",
        dir: "/shop",
        repo: "acme/shop",
        base: "develop",
        state: "running",
        current: -1,
        items,
        ciruns: 0,
        startedat: 1,
        ...extra,
    };
}

function pr(number: number, base = "develop"): ReviewPr {
    return {
        number,
        title: `Synthetic change ${number}`,
        url: `https://github.com/acme/shop/pull/${number}`,
        branch: `feature/${number}-x`,
        base,
        headoid: "a".repeat(40),
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: "success", success: 3, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
    } as ReviewPr;
}

function queueOf(...numbers: number[]): MergeQueue {
    return {
        usable: true,
        steps: numbers.map((number, i) => ({
            number,
            rank: i + 1,
            rebase: false,
            wait: false,
            rebaseAfter: [],
            before: [],
        })),
        outside: [],
        cost: 0,
        listCost: 0,
        uptodate: "notrequired",
    };
}

// What the run looks like halfway: #11 merged, #12 being rebased, #13 waits its turn.
function halfway(extra: Partial<BatchRun> = {}): BatchRun {
    return run(
        [
            item(11, { state: "merged", endedat: 5 }),
            item(12, { state: "rebasing", rebases: 1, startedat: 4 }),
            item(13, { state: "queued" }),
        ],
        { current: 1, ...extra }
    );
}

describe("a group merge that runs (#2318)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("runs from its confirmation until it ends, fails or is cancelled", () => {
        expect(groupMergeRunning(halfway())).toBe(true);
        expect(groupMergeRunning(halfway({ state: "cancelling", cancelasked: true }))).toBe(true);
        expect(groupMergeRunning(halfway({ state: "cancelled" }))).toBe(false);
        expect(groupMergeRunning(halfway({ state: "done" }))).toBe(false);
        expect(groupMergeRunning(halfway({ state: "interrupted" }))).toBe(false);
        expect(groupMergeRunning(null)).toBe(false);
    });

    it("is not a queue of validated PRs, and not a PR set aside on a failing check", () => {
        expect(groupMergeRunning(run([item(11, { source: "validate" })]))).toBe(false);
        expect(groupMergeRunning(run([item(11, { state: "failed", reason: "failing" })]))).toBe(false);
        expect(groupMergeRunning(run([item(11, { state: "stopped", reason: "ambiguous" }), item(12)]))).toBe(true);
        expect(
            groupMergeRunning(run([item(11, { state: "merged" }), item(12, { source: "validate", state: "queued" })]))
        ).toBe(false);
    });

    it("hides the suggested order, and brings it back once the run ended or was cancelled", () => {
        const queue = queueOf(21, 22, 23);
        expect(queueOrderShown(queue, null)).toBe(true);
        expect(queueOrderShown(queue, halfway())).toBe(false);
        expect(queueOrderShown(queue, halfway({ state: "cancelling", cancelasked: true }))).toBe(false);
        expect(queueOrderShown(queue, halfway({ state: "cancelled" }))).toBe(true);
        expect(queueOrderShown(queue, halfway({ state: "done" }))).toBe(true);
    });

    it("brings it back only if pull requests remain to merge now", () => {
        expect(queueOrderShown(queueOf(21), halfway({ state: "done" }))).toBe(false);
        expect(queueOrderShown(queueOf(), halfway({ state: "done" }))).toBe(false);
        expect(queueOrderShown(queueOf(21, 22), halfway({ state: "done" }))).toBe(true);
    });

    it("leaves a queue of validated PRs its order block", () => {
        const validated = run([item(11, { source: "validate" })]);
        expect(queueOrderShown(queueOf(21, 22), validated)).toBe(true);
    });

    it("is the same run for every panel of the project", () => {
        const runs = BatchRuns.getInstance();
        globalStore.set(runs.runsAtom, {});
        runs.store("/shop", "develop", halfway());
        const first = runs.runOf("/shop", "develop");
        const second = runs.runOf("/shop", "develop");
        expect(first).toBe(second);
        expect(groupMergeRunning(first)).toBe(true);
        runs.store("/shop", "develop", halfway({ state: "cancelled" }));
        expect(groupMergeRunning(runs.runOf("/shop", "develop"))).toBe(false);
        expect(runs.runOf("/shop", "main")).toBeNull();
    });
});

describe("what a running group merge holds of a PR (#2318)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("holds the PRs of the run, and every other PR into its base", () => {
        const r = halfway();
        expect(groupHoldOf(r, 12)).toBe("in");
        expect(groupHoldOf(r, 13)).toBe("in");
        expect(groupHoldOf(r, 99)).toBe("held");
        expect(groupHoldOf(null, 99)).toBeNull();
        expect(groupHoldOf(halfway({ state: "cancelled" }), 99)).toBeNull();
    });

    it("leaves the PR the run ended on, or set aside, its own moves", () => {
        const r = run([
            item(12, { state: "stopped", reason: "ambiguous" }),
            item(13, { state: "failed", reason: "failing" }),
            item(14, { state: "voided", reason: "pushed" }),
            item(15, { state: "withdrawn", reason: "withdrawn" }),
            item(16),
        ]);
        expect([12, 13, 14, 15, 16].map((n) => groupHoldOf(r, n))).toEqual([null, null, null, null, "in"]);
    });

    function cardsFor(prs: ReviewPr[], r: BatchRun) {
        const upcoming = { dir: "/shop", branches: [], agents: [], drafts: [], at: Start } as unknown as UpcomingAnswer;
        const ctx: CardContext = {
            upcoming,
            states: { states: {} } as unknown as AgentStatesData,
            now: Start,
            boardText: (s) => s,
            batchRun: (base) => (base === r.base ? r : null),
        };
        return cardStates(prs, {}, (n) => `/shop#${n}`, ctx);
    }

    it("takes the merge away from the PRs of the run: the run owns them, and says so", () => {
        const own = cardsFor([pr(13)], halfway())[13];
        expect([own.primary.id, wordPhrase(own.primary.disabled)]).toEqual([
            "validate",
            "In the group merge that runs into develop: it merges in its turn. Cancel the merge to take it back.",
        ]);
        expect(own.molten).toBe(false);
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(wordPhrase(own.primary.disabled)).toBe(
            "Dans la fusion groupée en cours vers develop : elle sera fusionnée à son tour. Annulez la fusion pour la reprendre."
        );
    });

    it("asks before the merge of another PR into its base, and never blocks it (#943)", () => {
        const other = cardsFor([pr(99)], halfway())[99];
        expect(other.primary.id).toBe("validate");
        expect(other.primary.disabled).toBeUndefined();
        expect(other.molten).toBe(true);
        expect(wordPhrase(other.primary.confirm)).toBe(
            "A group merge into develop is running; merging this now may make the next ones need a rebase."
        );
        expect(other.primary.confirmKeys).toEqual({
            yes: "reviews.card.confirm.mergeAnyway",
            no: "reviews.card.confirm.waitForRun",
        });
        expect([t(other.primary.confirmKeys.yes), t(other.primary.confirmKeys.no)]).toEqual([
            "Merge anyway",
            "Wait for the run",
        ]);
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(wordPhrase(other.primary.confirm)).toBe(
            "Une fusion groupée vers develop est en cours ; fusionner celle-ci maintenant peut obliger les suivantes à être rebasées."
        );
        expect([t(other.primary.confirmKeys.yes), t(other.primary.confirmKeys.no)]).toEqual([
            "Fusionner quand même",
            "Attendre la fusion groupée",
        ]);
    });

    it("words the two buttons of the card's confirmation: Merge anyway and Wait for the run, else as before", () => {
        const held = cardsFor([pr(99)], halfway())[99].primary;
        expect(confirmKeysOf(held)).toEqual({
            yes: "reviews.card.confirm.mergeAnyway",
            no: "reviews.card.confirm.waitForRun",
        });
        const plain = { id: "validate", label: phrase("reviews.validate.button"), confirm: phrase("x") } as const;
        expect(confirmKeysOf(plain)).toEqual({ yes: "reviews.card.confirm.validateAnyway", no: "common.cancel" });
        expect([t("reviews.card.confirm.validateAnyway"), t("common.cancel")]).toEqual(["Validate anyway", "Cancel"]);
    });

    it("asks wherever the card offers the merge, its menu too", () => {
        const review = { ...pr(99), report: { state: "missing" } } as ReviewPr;
        const card = cardsFor([review], halfway())[99];
        const merges = [card.primary, ...card.menu].filter((a) => a?.id === "validate");
        expect(merges.length).toBeGreaterThan(0);
        for (const merge of merges) {
            expect([merge.disabled, merge.confirmKeys?.yes]).toEqual([undefined, "reviews.card.confirm.mergeAnyway"]);
        }
    });

    it("leaves a merge into another base alone", () => {
        const card = cardsFor([pr(98, "release")], halfway())[98];
        expect(card.primary.id).toBe("validate");
        expect(card.primary.disabled).toBeUndefined();
        expect(card.primary.confirm).toBeUndefined();
        expect(card.primary.confirmKeys).toBeUndefined();
        expect(card.molten).toBe(true);
    });

    it("gives the merge back, with no question, once the run stopped", () => {
        for (const state of ["cancelled", "done"] as const) {
            const cards = cardsFor([pr(13), pr(99)], halfway({ state }));
            for (const n of [13, 99]) {
                expect([cards[n].primary.disabled, cards[n].primary.confirm]).toEqual([undefined, undefined]);
            }
        }
    });

    it("leaves GitHub's own refusal first", () => {
        const conflicted = { ...pr(99), merge: "conflicts" } as ReviewPr;
        const card = cardsFor([conflicted], halfway())[99];
        const validate = [card.primary, ...card.menu].find((a) => a?.id === "validate");
        expect(wordPhrase(validate.disabled)).toContain("Conflicts with develop");
        expect(validate.confirm).toBeUndefined();
    });
});

describe("the progress that replaces the suggested order (#2318)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("lists every step of a group merge with its state, the merged one too", () => {
        expect(batchShownSteps(halfway()).map((it) => [it.number, it.state])).toEqual([
            [11, "merged"],
            [12, "rebasing"],
            [13, "queued"],
        ]);
        const html = renderToStaticMarkup(<BatchBanner run={halfway()} />);
        const steps = [...html.matchAll(/data-testid="reviews-batch-item" data-pr="(\d+)" data-state="(\w+)"/g)];
        expect(steps.map((m) => [m[1], m[2]])).toEqual([
            ["11", "merged"],
            ["12", "rebasing"],
            ["13", "queued"],
        ]);
        expect(html).toContain("Merged by the queue");
        expect(html).toContain("Your agent rebases it on develop");
        expect(html).toContain("Next in queue");
    });

    it("offers Cancel the merge, which says it stops after the step under way", () => {
        const html = renderToStaticMarkup(<BatchBanner run={halfway()} />);
        expect(html).toMatch(/data-testid="reviews-batch-cancel"[^>]*>[^<]*Cancel the merge/);
        expect(html).toContain(
            "Stops after the step under way: a merge or a push already started finishes, and nothing more is merged"
        );
        expect(html).not.toContain(">Stop<");
    });

    it("says it cancels, and offers no second click", () => {
        const html = renderToStaticMarkup(<BatchBanner run={halfway({ state: "cancelling", cancelasked: true })} />);
        expect(html).toContain("Cancelling…");
        expect(html).toContain('aria-disabled="true"');
        expect(html).toContain("Cancelling after the current step");
    });

    it("keeps a queue of validated PRs as it was: its open steps, and Stop", () => {
        const validated = run([item(11, { source: "validate", state: "merged" }), item(12, { source: "validate" })]);
        expect(batchShownSteps(validated).map((it) => it.number)).toEqual([12]);
        expect(batchCancelKeys(validated)).toEqual({
            label: "reviews.batch.cancel",
            title: "reviews.batch.cancelTitle",
        });
        const html = renderToStaticMarkup(<BatchBanner run={validated} />);
        expect(html).toMatch(/data-testid="reviews-batch-cancel"[^>]*>[^<]*Stop/);
    });

    it("words Cancel the merge in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = renderToStaticMarkup(<BatchBanner run={halfway()} />);
        expect(html).toContain("Annuler la fusion");
        expect(html).toContain("S&#x27;arrête après l&#x27;étape en cours");
    });
});
