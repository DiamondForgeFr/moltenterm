// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { Forecast, ForecastRowState } from "./reviews-forecast-model";
import { ReviewPr } from "./reviews-model";
import {
    ExactOrderMaxPrs,
    mergeOrderHeader,
    mergeOrderOfNodes,
    mergeOrderReason,
    mergeOutsideReason,
    orderCost,
    orderedPrs,
    OrderNode,
    orderTier,
    suggestedMergeOrder,
} from "./reviews-order-model";

const Base = "b".repeat(40);
const head = (n: number) => `h${n}`.padEnd(40, "0");

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid: head(number),
        baseoid: Base,
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [{ name: "ci", state: "success" }] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

// edges: [a, b] means merging #a puts #b in conflict.
function forecastOf(
    prs: ReviewPr[],
    edges: [number, number][],
    states: Record<number, ForecastRowState> = {},
    extra: Partial<Forecast> = {}
): Forecast {
    return {
        dir: "/p",
        key: "k",
        state: "ready",
        baseoid: Base,
        method: "squash",
        uptodate: "notrequired",
        rows: prs.map((p) => ({
            number: p.number,
            headoid: p.headoid,
            state: states[p.number] ?? "simulated",
            impacts: edges
                .filter(([a]) => a === p.number)
                .map(([, b]) => ({ number: b, headoid: head(b), paths: ["README.md"], pathcount: 1 })),
        })),
        ...extra,
    };
}

// The reference pricing of an order, on bitmasks: a PR is rebased when it conflicts with the base or an earlier merge
// put it in conflict.
function maskPricing(nodes: OrderNode[]): {
    stepCost: (v: number, placed: number) => number;
    costOf: (numbers: number[]) => number;
} {
    const index = new Map(nodes.map((x, i) => [x.number, i]));
    const impactedBy = nodes.map(() => 0);
    for (const [i, x] of nodes.entries()) {
        for (const b of x.impacts) {
            impactedBy[index.get(b)] |= 1 << i;
        }
    }
    const stepCost = (v: number, placed: number) =>
        nodes[v].group === "conflictsbase" || (impactedBy[v] & placed) !== 0 ? 1 : 0;
    const costOf = (numbers: number[]) => {
        let placed = 0;
        let cost = 0;
        for (const number of numbers) {
            const v = index.get(number);
            cost += stepCost(v, placed);
            placed |= 1 << v;
        }
        return cost;
    };
    return { stepCost, costOf };
}

// The fewest rebases over every merge order, walked depth first rather than listing the permutations: orders sharing a
// prefix share its cost and no order is built, so the exhaustive check stays cheap on a loaded machine (#1069).
function bestOrderCost(nodes: OrderNode[]): number {
    const { stepCost } = maskPricing(nodes);
    const full = (1 << nodes.length) - 1;
    let best = Infinity;
    const walk = (placed: number, cost: number) => {
        if (cost >= best) {
            return;
        }
        if (placed === full) {
            best = cost;
            return;
        }
        for (let v = 0; v < nodes.length; v++) {
            if (placed & (1 << v)) {
                continue;
            }
            walk(placed | (1 << v), cost + stepCost(v, placed));
        }
    };
    walk(0, 0);
    return best;
}

// A small deterministic generator, so a failing case can be replayed.
function random(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
}

function nodesOf(n: number, edges: [number, number][], conflictsbase: number[] = []): OrderNode[] {
    return Array.from({ length: n }, (_, i) => ({
        number: i + 1,
        index: i,
        group: conflictsbase.includes(i + 1) ? "conflictsbase" : "simulated",
        tier: 0,
        impacts: edges.filter(([a]) => a === i + 1).map(([, b]) => b),
    }));
}

describe("suggested merge order (FR-REV-024)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("puts the PRs with no impact first (AC-1)", () => {
        const prs = [pr(1), pr(2), pr(3), pr(4)];
        // #1 puts #2 and #3 in conflict; #4 puts #2 in conflict.
        const order = suggestedMergeOrder(
            forecastOf(prs, [
                [1, 2],
                [1, 3],
                [4, 2],
            ]),
            prs,
            prs
        );
        expect(order.usable).toBe(true);
        expect(order.numbers.slice(0, 2).sort()).toEqual([2, 3]);
        expect(order.cost).toBe(0);
        // The list's order: #1 first puts #2 and #3 in conflict.
        expect(order.currentCost).toBe(2);
        expect(order.numbers).toEqual([2, 3, 1, 4]);
        expect(mergeOrderReason(order.steps[2], "develop", prs[0])).toBe(
            "After #2, #3, which it would put in conflict"
        );
    });

    it("is optimal on random conflict graphs, checked against every order", () => {
        const rand = random(781);
        for (let round = 0; round < 150; round++) {
            const n = 2 + Math.floor(rand() * 6);
            const edges: [number, number][] = [];
            for (let a = 1; a <= n; a++) {
                for (let b = 1; b <= n; b++) {
                    if (a !== b && rand() < 0.3) {
                        edges.push([a, b]);
                    }
                }
            }
            const conflictsbase = rand() < 0.3 ? [n] : [];
            const nodes = nodesOf(
                n,
                edges.filter(([a, b]) => !conflictsbase.includes(a) && !conflictsbase.includes(b)),
                conflictsbase
            );
            const listOrder = nodes.map((x) => x.number);
            expect(maskPricing(nodes).costOf(listOrder)).toBe(orderCost(listOrder, nodes));
            const best = bestOrderCost(nodes);
            const { numbers, exact } = mergeOrderOfNodes(nodes);
            expect(exact).toBe(true);
            expect([...numbers].sort((a, b) => a - b)).toEqual(nodes.map((x) => x.number));
            expect(orderCost(numbers, nodes), JSON.stringify({ n, edges, conflictsbase })).toBe(best);
        }
    });

    it("breaks a conflict cycle with one rebase", () => {
        // #1 and #2 put each other in conflict: one of them is rebased whatever the order.
        const nodes = nodesOf(3, [
            [1, 2],
            [2, 1],
            [1, 3],
        ]);
        const { numbers } = mergeOrderOfNodes(nodes);
        expect(orderCost(numbers, nodes)).toBe(1);
        expect(numbers[0]).toBe(3);
    });

    it("prefers the PRs mergeable now when it costs nothing", () => {
        const prs = [
            pr(1, { ci: { state: "failure", success: 0, failure: 1, pending: 0, checks: [] } }),
            pr(2, { ci: { state: "pending", success: 0, failure: 0, pending: 1, checks: [] } }),
            pr(3),
        ];
        const order = suggestedMergeOrder(forecastOf(prs, []), prs, prs);
        expect(order.numbers).toEqual([3, 2, 1]);
        expect(order.cost).toBe(0);
    });

    it("keeps the cost first over the CI state", () => {
        // #1 is mergeable now but puts #2 in conflict; #2, CI running, goes first.
        const prs = [pr(1), pr(2, { ci: { state: "pending", success: 0, failure: 0, pending: 1, checks: [] } })];
        const order = suggestedMergeOrder(forecastOf(prs, [[1, 2]]), prs, prs);
        expect(order.numbers).toEqual([2, 1]);
        expect(order.cost).toBe(0);
        expect(order.currentCost).toBe(1);
    });

    it("leaves the PRs already conflicting with the base out of the order, those not forecast last (#1059)", () => {
        const prs = [pr(1, { merge: "conflicts" }), pr(2), pr(3), pr(4), pr(5, { merge: "conflicts" })];
        // #1 conflicts by the forecast and GitHub, #5 by GitHub only.
        const order = suggestedMergeOrder(forecastOf(prs, [[2, 3]], { 1: "conflictsbase", 4: "missing" }), prs, prs);
        expect(order.numbers).toEqual([3, 2, 4]);
        expect(order.steps.map((s) => s.rank)).toEqual([1, 2, 3]);
        expect(order.outside.map((s) => s.number)).toEqual([1, 5]);
        expect(order.outside.every((s) => s.rebase)).toBe(true);
        // Their rebase happens in any order: neither cost counts it.
        expect(order.cost).toBe(0);
        expect(order.currentCost).toBe(1);
        expect(orderedPrs(order, prs).map((p) => p.number)).toEqual([3, 2, 4, 1, 5]);
        expect(mergeOutsideReason("develop")).toBe("Outside the order: already conflicts with develop");
    });

    it("ranks running checks as waiting, not as failing (#1059)", () => {
        const running = { state: "pending" as const, success: 1, failure: 0, pending: 1, checks: [] };
        const failing = { state: "failure" as const, success: 0, failure: 1, pending: 0, checks: [] };
        expect(orderTier(pr(1, { merge: "running", ci: running }))).toBe(1);
        expect(orderTier(pr(1, { merge: "unknown", ci: running }))).toBe(1);
        // GitHub blocks while required checks run: waiting too, unless a review blocks it.
        expect(orderTier(pr(1, { merge: "blocked", ci: running }))).toBe(1);
        expect(orderTier(pr(1, { merge: "blocked", ci: running, reviewdecision: "REVIEW_REQUIRED" }))).toBe(2);
        expect(orderTier(pr(1, { merge: "blocked" }))).toBe(2);
        expect(orderTier(pr(1, { merge: "failing", ci: failing }))).toBe(2);
        expect(orderTier(pr(1, { merge: "clean", ci: failing }))).toBe(2);
        // Same cost: the running one before the failing one.
        const prs = [pr(1, { merge: "failing", ci: failing }), pr(2, { merge: "running", ci: running })];
        const order = suggestedMergeOrder(forecastOf(prs, []), prs, prs);
        expect(order.numbers).toEqual([2, 1]);
        expect(mergeOrderReason(order.steps[0], "develop", prs[1])).toBe("No impact · CI running");
    });

    it("reads only the impacts on the PRs it orders, with the head the forecast saw", () => {
        const draft = pr(9, { draft: true });
        const pushed = pr(2, { headoid: head(22) });
        const prs = [pr(1), pushed];
        // #1 puts the draft and #2's old head in conflict: neither counts.
        const forecast = forecastOf(
            [pr(1), pr(2), draft],
            [
                [1, 9],
                [1, 2],
            ]
        );
        const order = suggestedMergeOrder(forecast, prs, [...prs, draft]);
        expect(order.usable).toBe(true);
        expect(order.cost).toBe(0);
        expect(order.steps.find((s) => s.number === 2).group).toBe("missing");
    });

    it("keeps the list's order while the forecast cannot say", () => {
        const prs = [pr(1), pr(2)];
        for (const forecast of [
            null,
            { ...forecastOf(prs, [[1, 2]]), state: "failed" as const },
            { ...forecastOf(prs, [[1, 2]]), baseoid: "c".repeat(40) },
        ]) {
            const order = suggestedMergeOrder(forecast, prs, prs);
            expect(order.usable).toBe(false);
            expect(order.numbers).toEqual([1, 2]);
            expect(orderedPrs(order, prs)).toBe(prs);
            expect(mergeOrderHeader(order, true).kind).toBe("none");
        }
    });

    it("follows the forecast as it changes (AC-5)", () => {
        const prs = [pr(1), pr(2)];
        expect(suggestedMergeOrder(forecastOf(prs, [[1, 2]]), prs, prs).numbers).toEqual([2, 1]);
        expect(suggestedMergeOrder(forecastOf(prs, [[2, 1]]), prs, prs).numbers).toEqual([1, 2]);
    });

    it("orders twenty linked PRs exactly", () => {
        const n = ExactOrderMaxPrs;
        // A chain #k → #k+1 and a few back edges.
        const edges: [number, number][] = [];
        for (let k = 1; k < n; k++) {
            edges.push([k, k + 1]);
        }
        edges.push([n, 1], [10, 3], [15, 7]);
        const nodes = nodesOf(n, edges);
        const { numbers, exact } = mergeOrderOfNodes(nodes);
        expect(exact).toBe(true);
        // Three cycles (the ring, #3–#10, #7–#15) all go through #7–#10: a single rebase breaks them.
        expect(orderCost(numbers, nodes)).toBe(1);
    });

    it("falls back to a greedy past the exact size", () => {
        const n = ExactOrderMaxPrs + 2;
        const edges: [number, number][] = [];
        for (let k = 1; k < n; k++) {
            edges.push([k, k + 1]);
        }
        const nodes = nodesOf(n, edges);
        const { numbers, exact } = mergeOrderOfNodes(nodes);
        expect(exact).toBe(false);
        // A chain merges from its end: no rebase.
        expect(orderCost(numbers, nodes)).toBe(0);
        expect(numbers[0]).toBe(n);
    });
});

describe("merge order wording", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("states the cost of both orders (AC-2)", () => {
        const prs = [pr(1), pr(2), pr(3)];
        const order = suggestedMergeOrder(
            forecastOf(prs, [
                [1, 2],
                [1, 3],
            ]),
            prs,
            prs
        );
        expect(mergeOrderHeader(order, true).text).toBe("This order: 0 CI runs to redo — current order: 2");
        expect(mergeOrderHeader(order, false).text).toBe("List order: 2 CI runs to redo — suggested order: 0");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(mergeOrderHeader(order, true).text).toBe("Cet ordre : 0 CI à relancer — ordre actuel : 2");
    });

    it("uses the singular for one run", () => {
        const prs = [pr(1), pr(2)];
        const order = suggestedMergeOrder(
            forecastOf(prs, [
                [1, 2],
                [2, 1],
            ]),
            prs,
            prs
        );
        expect(mergeOrderHeader(order, true).text).toBe("This order: 1 CI run to redo — current order: 1");
    });

    it("says ordering saves no CI run when branches must be up to date (AC-3)", () => {
        const prs = [pr(1), pr(2)];
        const order = suggestedMergeOrder(forecastOf(prs, [[1, 2]], {}, { uptodate: "required" }), prs, prs);
        const header = mergeOrderHeader(order, true);
        expect(header.kind).toBe("uptodate");
        expect(header.text).toBe("Up-to-date branches required here: ordering saves no CI run");
    });

    it("says so when the rule could not be read", () => {
        const prs = [pr(1), pr(2)];
        const order = suggestedMergeOrder(forecastOf(prs, [[1, 2]], {}, { uptodate: "unknown" }), prs, prs);
        const header = mergeOrderHeader(order, true);
        expect(header.text).toBe(
            "This order: 0 CI runs to redo — current order: 1 (if branches need not be up to date)"
        );
        expect(header.title).toContain("could not be read");
    });

    it("explains each row's place in one line (AC-4)", () => {
        const prs = [
            pr(1),
            pr(2),
            pr(3, { ci: { state: "pending", success: 0, failure: 0, pending: 1, checks: [] } }),
            pr(4, { merge: "conflicts" }),
            pr(5),
        ];
        // #1 and #2 put each other in conflict, #2 puts #5 in conflict too.
        const order = suggestedMergeOrder(
            forecastOf(
                prs,
                [
                    [1, 2],
                    [2, 1],
                    [2, 5],
                ],
                { 4: "conflictsbase" }
            ),
            prs,
            prs
        );
        const reasons = Object.fromEntries(
            order.steps.map((s) => [
                s.number,
                mergeOrderReason(
                    s,
                    "develop",
                    prs.find((p) => p.number === s.number)
                ),
            ])
        );
        expect(order.numbers).toEqual([5, 3, 1, 2]);
        expect(reasons[3]).toBe("No impact · CI running");
        expect(reasons[5]).toBe("No impact");
        expect(reasons[1]).toBe("Puts #2 in conflict");
        expect(reasons[2]).toBe("Rebase after #1");
        expect(mergeOrderReason(order.outside[0], "develop", prs[3])).toBe(
            "Already conflicts with develop: rebase in any order"
        );
        expect(order.steps.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
    });
});
