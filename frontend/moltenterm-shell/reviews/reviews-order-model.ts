// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The suggested merge order (FR-REV-024): the order of the PRs waiting for review that spends the fewest CI runs.
// A PR whose base moved reruns its CI only when it has to be rebased: when an earlier merge of the sequence puts it in
// conflict (the forecast's impacts, FR-REV-023), or when it already conflicts with the base. Pure, so the batch merge
// (#782) orders its PRs with suggestedMergeOrder and prices any sequence with orderCost.

import { t } from "../i18n/i18n";
import { Forecast, forecastBaseOid, ForecastUpToDate, impactsOf, rowOf } from "./reviews-forecast-model";
import { mergeableNow, type ReviewPr } from "./reviews-model";

// Past this many PRs linked by conflicts, the exact search (2^n states) gives way to a greedy.
export const ExactOrderMaxPrs = 20;

// simulated: the forecast merged it; conflictsbase: it already conflicts with the base, by the forecast or GitHub (a
// rebase in any order, so it is left out of the suggested order, #1059); missing: the forecast has no row for its head
// yet.
export type OrderGroup = "simulated" | "missing" | "conflictsbase";

// 0 mergeable now, 1 waiting (checks running, merge state computing), 2 cannot merge (checks failing, blocked).
export type OrderTier = 0 | 1 | 2;

export type OrderNode = {
    number: number;
    index: number;
    group: OrderGroup;
    tier: OrderTier;
    // The PRs (by number) merging this one would put in conflict, among those ordered.
    impacts: number[];
};

export type MergeOrderStep = {
    number: number;
    rank: number;
    group: OrderGroup;
    tier: OrderTier;
    // A rebase, hence a CI run, is needed before it merges in this order.
    rebase: boolean;
    // The earlier PRs of the order whose merge puts it in conflict.
    rebaseAfter: number[];
    // The later PRs of the order its merge puts in conflict.
    impactsLater: number[];
    // The earlier PRs it would have put in conflict, merged before it for that reason.
    impactsEarlier: number[];
};

export type MergeOrder = {
    // The forecast could order the list: false while it computes, failed or is about another base.
    usable: boolean;
    numbers: number[];
    steps: MergeOrderStep[];
    // The PRs already conflicting with the base, left out of the order (#1059): their rebase does not depend on it.
    // The batch merge still takes them, after the order.
    outside: MergeOrderStep[];
    // CI runs to redo merging in this order, and in the list's own order.
    cost: number;
    currentCost: number;
    uptodate: ForecastUpToDate;
    // Every group of linked PRs was small enough for the exact search.
    exact: boolean;
};

export function orderTier(pr: ReviewPr): OrderTier {
    if (mergeableNow(pr)) {
        return 0;
    }
    if (pr.ci?.state === "failure" || pr.merge === "failing" || pr.merge === "conflicts") {
        return 2;
    }
    if (pr.merge === "blocked" && !blockedOnRunningChecks(pr)) {
        return 2;
    }
    return 1;
}

// blockedOnRunningChecks: GitHub blocks the merge while required checks still run (#1059); the PR waits for them, it
// does not fail. A review asked or changes requested still block it.
function blockedOnRunningChecks(pr: ReviewPr): boolean {
    if (pr.ci?.state !== "pending") {
        return false;
    }
    const decision = (pr.reviewdecision ?? "").toUpperCase();
    return decision !== "REVIEW_REQUIRED" && decision !== "CHANGES_REQUESTED";
}

// orderNodes reads the forecast for the PRs to order (the list's ready ones); listed are all the PRs the forecast was
// asked about (ready and drafts), which its rows are matched against. null when the forecast cannot order them.
export function orderNodes(forecast: Forecast, ready: ReviewPr[], listed: ReviewPr[]): OrderNode[] {
    if (forecast?.state !== "ready" || ready == null || ready.length === 0) {
        return null;
    }
    const baseoid = forecastBaseOid(listed);
    if (!baseoid || forecast.baseoid !== baseoid) {
        return null;
    }
    const numbers = new Set(ready.map((pr) => pr.number));
    let known = 0;
    const nodes = ready.map((pr, index): OrderNode => {
        const row = rowOf(forecast, pr, baseoid);
        const group: OrderGroup =
            pr.merge === "conflicts" || row?.state === "conflictsbase"
                ? "conflictsbase"
                : row == null || row.state === "missing"
                  ? "missing"
                  : "simulated";
        if (row != null) {
            known++;
        }
        const impacts =
            group === "simulated"
                ? impactsOf(forecast, pr, listed)
                      .map((i) => i.number)
                      .filter((n) => n !== pr.number && numbers.has(n))
                : [];
        return { number: pr.number, index, group, tier: orderTier(pr), impacts: [...new Set(impacts)] };
    });
    return known === 0 ? null : nodes;
}

// orderCost: the CI runs to redo merging the PRs in this sequence, the PRs not in the nodes counting for nothing.
export function orderCost(numbers: number[], nodes: OrderNode[]): number {
    return orderSteps(numbers, nodes).filter((s) => s.rebase).length;
}

function orderSteps(numbers: number[], nodes: OrderNode[]): MergeOrderStep[] {
    const byNumber = new Map(nodes.map((n) => [n.number, n]));
    const position = new Map(numbers.map((n, i) => [n, i]));
    const steps: MergeOrderStep[] = [];
    for (const [i, number] of numbers.entries()) {
        const node = byNumber.get(number);
        if (node == null) {
            continue;
        }
        const before = (n: number) => position.has(n) && position.get(n) < i;
        const rebaseAfter = nodes.filter((o) => o.impacts.includes(number) && before(o.number)).map((o) => o.number);
        steps.push({
            number,
            rank: steps.length + 1,
            group: node.group,
            tier: node.tier,
            rebase: node.group === "conflictsbase" || rebaseAfter.length > 0,
            rebaseAfter,
            impactsLater: node.impacts.filter((n) => position.has(n) && !before(n)),
            impactsEarlier: node.impacts.filter(before),
        });
    }
    return steps;
}

const GroupRank: Record<OrderGroup, number> = { simulated: 0, missing: 1, conflictsbase: 2 };

// The tie order among choices that cost the same: no impact first, then growing impact (on the PRs not merged yet),
// mergeable-now before waiting before blocked, then the list's own order.
function compareKeys(a: number[], b: number[]): number {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return 0;
}

// components: the groups of PRs linked by impacts, either way. The cost of an order only depends on the relative
// order inside each group, so each is ordered on its own.
function components(nodes: OrderNode[]): number[][] {
    const index = new Map(nodes.map((n, i) => [n.number, i]));
    const parent = nodes.map((_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    for (const [i, node] of nodes.entries()) {
        for (const n of node.impacts) {
            const j = index.get(n);
            if (j != null) {
                parent[find(i)] = find(j);
            }
        }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < nodes.length; i++) {
        const root = find(i);
        groups.set(root, [...(groups.get(root) ?? []), i]);
    }
    return [...groups.values()];
}

// orderComponent orders one group of linked PRs (indexes into nodes): exactly up to ExactOrderMaxPrs PRs, greedily past.
// f[placed] is the fewest rebases to merge the PRs not in placed once those in placed are merged; the order is then
// read from the empty set, among the optimal choices the one with the best tie key.
function orderComponent(nodes: OrderNode[], members: number[]): { order: number[]; exact: boolean } {
    const k = members.length;
    if (k === 1) {
        return { order: members, exact: true };
    }
    const local = new Map(members.map((m, i) => [nodes[m].number, i]));
    const inMask = new Array<number>(k).fill(0);
    const outMask = new Array<number>(k).fill(0);
    const always = members.map((m) => (nodes[m].group === "conflictsbase" ? 1 : 0));
    for (const [i, m] of members.entries()) {
        for (const n of nodes[m].impacts) {
            const j = local.get(n);
            if (j != null) {
                inMask[j] |= 1 << i;
                outMask[i] |= 1 << j;
            }
        }
    }
    const stepCost = (v: number, placed: number) => (always[v] || (inMask[v] & placed) !== 0 ? 1 : 0);
    const key = (v: number, placed: number) => {
        const node = nodes[members[v]];
        return [GroupRank[node.group], popcount(outMask[v] & ~placed), node.tier, node.index];
    };
    const exact = k <= ExactOrderMaxPrs;
    const full = (1 << k) - 1;
    let f: Uint8Array = null;
    if (exact) {
        f = new Uint8Array(full + 1);
        for (let placed = full - 1; placed >= 0; placed--) {
            let best = 255;
            for (let v = 0; v < k; v++) {
                const bit = 1 << v;
                if (placed & bit) {
                    continue;
                }
                const cost = stepCost(v, placed) + f[placed | bit];
                if (cost < best) {
                    best = cost;
                }
            }
            f[placed] = best;
        }
    }
    const order: number[] = [];
    let placed = 0;
    while (order.length < k) {
        let pick = -1;
        let pickKey: number[] = null;
        for (let v = 0; v < k; v++) {
            if (placed & (1 << v)) {
                continue;
            }
            const cost = stepCost(v, placed);
            if (exact && cost + f[placed | (1 << v)] !== f[placed]) {
                continue;
            }
            const vKey = exact ? key(v, placed) : [cost, ...key(v, placed)];
            if (pick < 0 || compareKeys(vKey, pickKey) < 0) {
                pick = v;
                pickKey = vKey;
            }
        }
        order.push(pick);
        placed |= 1 << pick;
    }
    return { order: order.map((v) => members[v]), exact };
}

function popcount(x: number): number {
    let n = 0;
    while (x) {
        x &= x - 1;
        n++;
    }
    return n;
}

// mergeOrderOfNodes: the order spending the fewest CI runs. The groups' own orders are then woven together, the best
// tie key first: interleaving groups changes no cost.
export function mergeOrderOfNodes(nodes: OrderNode[]): { numbers: number[]; exact: boolean } {
    let exact = true;
    const queues = components(nodes).map((members) => {
        const solved = orderComponent(nodes, members);
        exact &&= solved.exact;
        return solved.order;
    });
    const merged = new Set<number>();
    const numbers: number[] = [];
    const key = (i: number) => {
        const node = nodes[i];
        const pending = node.impacts.filter((n) => !merged.has(n)).length;
        return [GroupRank[node.group], pending, node.tier, node.index];
    };
    while (queues.some((q) => q.length > 0)) {
        let pick = -1;
        for (const [qi, q] of queues.entries()) {
            if (q.length === 0) {
                continue;
            }
            if (pick < 0 || compareKeys(key(q[0]), key(queues[pick][0])) < 0) {
                pick = qi;
            }
        }
        const node = nodes[queues[pick].shift()];
        merged.add(node.number);
        numbers.push(node.number);
    }
    return { numbers, exact };
}

// suggestedMergeOrder orders the PRs waiting for review (ready) for the fewest CI runs, from the forecast about the
// listed PRs (ready and drafts). Not usable while the forecast cannot say: the list's order is kept then.
export function suggestedMergeOrder(forecast: Forecast, ready: ReviewPr[], listed: ReviewPr[]): MergeOrder {
    const current = (ready ?? []).map((pr) => pr.number);
    const uptodate = forecast?.uptodate ?? "unknown";
    const nodes = orderNodes(forecast, ready, listed);
    if (nodes == null) {
        return {
            usable: false,
            numbers: current,
            steps: [],
            outside: [],
            cost: 0,
            currentCost: 0,
            uptodate,
            exact: true,
        };
    }
    const ordered = nodes.filter((n) => n.group !== "conflictsbase");
    const left = nodes.filter((n) => n.group === "conflictsbase").map((n) => n.number);
    const { numbers, exact } = mergeOrderOfNodes(ordered);
    const steps = orderSteps(numbers, ordered);
    return {
        usable: true,
        numbers,
        steps,
        outside: orderSteps(left, nodes),
        cost: steps.filter((s) => s.rebase).length,
        currentCost: orderCost(current, ordered),
        uptodate,
        exact,
    };
}

// mergeOutsideReason: why a PR already conflicting with the base has no rank (#1059).
export function mergeOutsideReason(base: string): string {
    return t("reviews.order.reason.outside", { base: base || "base" });
}

// orderedPrs: the PRs in the order's sequence, any PR the order does not know kept after, in the list's order.
export function orderedPrs(order: MergeOrder, prs: ReviewPr[]): ReviewPr[] {
    if (order == null || !order.usable) {
        return prs;
    }
    const position = new Map(order.numbers.map((n, i) => [n, i]));
    const known = prs.filter((pr) => position.has(pr.number));
    known.sort((a, b) => position.get(a.number) - position.get(b.number));
    return [...known, ...prs.filter((pr) => !position.has(pr.number))];
}

function plural(n: number, key: string, vars: Record<string, string | number> = {}): string {
    return t(n === 1 ? `${key}.one` : `${key}.other`, { count: n, ...vars });
}

export function prsText(numbers: number[], ids?: Record<number, number>): string {
    return numbers.map((n) => `#${ids?.[n] ?? n}`).join(", ");
}

// mergeOrderReason: why a PR takes its place, in one short line.
export function mergeOrderReason(
    step: MergeOrderStep,
    base: string,
    pr?: ReviewPr,
    ids?: Record<number, number>
): string {
    const parts: string[] = [];
    if (step.group === "conflictsbase") {
        parts.push(t("reviews.order.reason.conflictsBase", { base: base || "base" }));
    } else if (step.group === "missing") {
        parts.push(t("reviews.order.reason.missing"));
    } else {
        if (step.rebaseAfter.length > 0) {
            parts.push(t("reviews.order.reason.rebaseAfter", { prs: prsText(step.rebaseAfter, ids) }));
        }
        if (step.impactsLater.length > 0) {
            parts.push(t("reviews.order.reason.puts", { prs: prsText(step.impactsLater, ids) }));
        } else if (step.impactsEarlier.length > 0 && step.rebaseAfter.length === 0) {
            parts.push(t("reviews.order.reason.after", { prs: prsText(step.impactsEarlier, ids) }));
        }
        if (parts.length === 0) {
            parts.push(t("reviews.order.reason.noImpact"));
        }
    }
    if (pr?.ci?.state === "failure") {
        parts.push(t("reviews.order.reason.ciFailing"));
    } else if (pr?.ci?.state === "pending") {
        parts.push(t("reviews.order.reason.ciRunning"));
    } else if (step.tier === 2 && step.group !== "conflictsbase") {
        parts.push(t("reviews.order.reason.blocked"));
    }
    return parts.join(" · ");
}

export type MergeOrderHeader = { text: string; title: string; kind: "cost" | "uptodate" | "none" };

// mergeOrderHeader: what the order costs, for the order shown (suggested or the list's own).
export function mergeOrderHeader(order: MergeOrder, suggested: boolean): MergeOrderHeader {
    if (order == null || !order.usable) {
        return { text: "", title: "", kind: "none" };
    }
    if (order.uptodate === "required") {
        return {
            text: t("reviews.order.upToDate"),
            title: t("reviews.order.upToDateTitle"),
            kind: "uptodate",
        };
    }
    const vars = suggested ? { other: order.currentCost } : { other: order.cost };
    const shown = suggested ? order.cost : order.currentCost;
    let text = plural(shown, suggested ? "reviews.order.costSuggested" : "reviews.order.costList", vars);
    const titles = [t("reviews.order.costTitle")];
    if (order.uptodate === "unknown") {
        text = `${text} ${t("reviews.order.unknownRule")}`;
        titles.push(t("reviews.order.unknownRuleTitle"));
    }
    if (!order.exact) {
        titles.push(t("reviews.order.greedy", { max: ExactOrderMaxPrs }));
    }
    return { text, title: titles.join("\n"), kind: "cost" };
}
