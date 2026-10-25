// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews merge queue (#1062, FR-REV-023 to FR-REV-025): the suggested merge order (reviews-order-model.ts) as a
// numbered queue readable without hovering, the conflict relations between cards both ways, the words that give each
// card its place in the order's direction, and what changed after a merge. Pure: the view and the tests read the same
// queue. Sentences are phrases, worded where they show.

import { joinPhrases, phrase, type Phrase } from "../i18n/phrase";
import { Forecast, impactedBy, impactsOf, pathsText } from "./reviews-forecast-model";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import { orderTier, suggestedMergeOrder } from "./reviews-order-model";

// The queue shows from this many steps: with one, Merge in this order is the card's own Validate.
export const QueueMinSteps = 2;

export type QueueStep = {
    number: number;
    rank: number;
    // Rebased by the developer's agent before its merge (an earlier merge of the queue puts it in conflict).
    rebase: boolean;
    // Its CI still runs, or GitHub still computes its mergeability: the queue waits for it.
    wait: boolean;
    // The earlier steps whose merge puts it in conflict, and the later ones its merge puts in conflict.
    rebaseAfter: number[];
    before: number[];
    // Merged since the last read: struck through until the next one (FR-REV-024).
    merged?: boolean;
};

export type MergeQueue = {
    // The forecast ordered the steps; false while it computes, failed or is about another base (list order then).
    usable: boolean;
    steps: QueueStep[];
    // The PRs left out because they already conflict with the base (#1059): Hand the rebase over, in Blocked.
    outside: number[];
    // Rebases (hence CI runs) merging in the queue's order, and in the list's order.
    cost: number;
    listCost: number;
    uptodate: "required" | "notrequired" | "unknown";
};

export type ConflictPartner = { number: number; draft: boolean; paths: string[]; pathcount: number };

function ciWaits(pr: ReviewPr): boolean {
    return (pr.ci?.pending ?? 0) > 0 || pr.ci?.state === "pending" || pr.merge === "running" || pr.merge === "unknown";
}

function conflictsBase(pr: ReviewPr): boolean {
    return pr.merge === "conflicts";
}

// queueCandidates: the PRs the queue may hold: ready for review, and mergeable now or waiting for their CI; those
// already conflicting with the base too, which the order leaves out and the queue names. Failing or blocked PRs are
// not steps: they sit in Blocked with their own action.
export function queueCandidates(ready: readonly ReviewPr[]): ReviewPr[] {
    return (ready ?? []).filter((pr) => !pr.draft && (orderTier(pr) < 2 || conflictsBase(pr)));
}

// mergeQueue: the numbered queue for the PRs ready for review, from the forecast about every listed PR.
export function mergeQueue(forecast: Forecast, ready: readonly ReviewPr[], listed: readonly ReviewPr[]): MergeQueue {
    const candidates = queueCandidates(ready);
    const byNumber = new Map(candidates.map((pr) => [pr.number, pr]));
    const order = suggestedMergeOrder(forecast, candidates, [...listed]);
    if (!order.usable) {
        const steps = candidates
            .filter((pr) => !conflictsBase(pr))
            .map((pr, i) => ({
                number: pr.number,
                rank: i + 1,
                rebase: false,
                wait: ciWaits(pr),
                rebaseAfter: [],
                before: [],
            }));
        return {
            usable: false,
            steps,
            outside: candidates.filter(conflictsBase).map((pr) => pr.number),
            cost: 0,
            listCost: 0,
            uptodate: order.uptodate,
        };
    }
    const steps = order.steps.map((s) => ({
        number: s.number,
        rank: s.rank,
        rebase: s.rebase,
        wait: ciWaits(byNumber.get(s.number)),
        rebaseAfter: s.rebaseAfter,
        before: s.impactsLater,
    }));
    return {
        usable: true,
        steps,
        outside: order.outside.map((s) => s.number),
        cost: order.cost,
        listCost: order.currentCost,
        uptodate: order.uptodate,
    };
}

// queueShown: the queue earns its block from QueueMinSteps steps.
export function queueShown(queue: MergeQueue): boolean {
    return queue != null && queue.steps.filter((s) => !s.merged).length >= QueueMinSteps;
}

// withMerged: the steps merged since the last read, struck through at the head of the queue (FR-REV-024).
export function withMerged(queue: MergeQueue, merged: readonly number[]): MergeQueue {
    if (queue == null || merged == null || merged.length === 0) {
        return queue;
    }
    const struck = merged
        .filter((n) => !queue.steps.some((s) => s.number === n))
        .map((number) => ({ number, rank: 0, rebase: false, wait: false, rebaseAfter: [], before: [], merged: true }));
    return { ...queue, steps: [...struck, ...queue.steps] };
}

// queueRanks: each step's rank, for the cards and the merge-order sort.
export function queueRanks(queue: MergeQueue): Record<number, number> {
    const rtn: Record<number, number> = {};
    for (const s of queue?.steps ?? []) {
        if (!s.merged) {
            rtn[s.number] = s.rank;
        }
    }
    return rtn;
}

export function prPhrase(number: number, draft = false): Phrase {
    return phrase(draft ? "reviews.queue.draftPr" : "reviews.queue.pr", { number });
}

// listPhrase: "#1", "#1 and #2", "#1, #2 and #3", in the interface language.
export function listPhrase(items: Phrase[]): Phrase {
    if (items.length === 0) {
        return null;
    }
    if (items.length === 1) {
        return items[0];
    }
    return phrase("reviews.queue.listAnd", {
        head: joinPhrases(items.slice(0, -1), ", "),
        last: items[items.length - 1],
    });
}

function prsPhrase(numbers: number[], drafts?: Set<number>): Phrase {
    return listPhrase(numbers.map((n) => prPhrase(n, drafts?.has(n))));
}

// queueCost: the cost in rebases avoided ("2 rebases instead of 3 in list order"); null while the order is unknown.
export function queueCost(queue: MergeQueue): Phrase {
    if (queue == null || !queue.usable) {
        return null;
    }
    if (queue.uptodate === "required") {
        return phrase("reviews.queue.cost.upToDate");
    }
    if (queue.cost === 0) {
        return phrase("reviews.queue.cost.none");
    }
    const count = queue.cost === 1 ? "one" : "other";
    if (queue.listCost > queue.cost) {
        return phrase(`reviews.queue.cost.saved.${count}`, { count: queue.cost, list: queue.listCost });
    }
    return phrase(`reviews.queue.cost.same.${count}`, { count: queue.cost });
}

// queueLegend: the marks shown explained, and the PRs left out of the queue named.
export function queueLegend(queue: MergeQueue, base: string): Phrase {
    if (queue == null) {
        return null;
    }
    const parts: Phrase[] = [];
    const live = queue.steps.filter((s) => !s.merged);
    if (live.some((s) => s.rebase)) {
        parts.push(phrase("reviews.queue.legend.rebase"));
    }
    if (live.some((s) => s.wait)) {
        parts.push(phrase("reviews.queue.legend.wait"));
    }
    if (queue.outside.length > 0) {
        parts.push(
            phrase(
                queue.outside.length === 1 ? "reviews.queue.legend.outside.one" : "reviews.queue.legend.outside.other",
                {
                    prs: prsPhrase(queue.outside),
                    base: base || "base",
                }
            )
        );
    }
    return parts.length === 0 ? null : joinPhrases(parts, " · ");
}

// queueWhy: a card's place in the order's direction, for its state line: the queue waits for its CI, it is rebased
// after the earlier steps that put it in conflict, it goes before the later ones it puts in conflict, or it touches
// no other PR. null for a PR that is no step.
export function queueWhy(queue: MergeQueue, number: number, partners: ConflictPartner[]): Phrase {
    const step = queue?.steps.find((s) => s.number === number && !s.merged);
    if (step == null) {
        return null;
    }
    if (step.wait) {
        return phrase("reviews.queue.why.wait");
    }
    if (!queue.usable) {
        return null;
    }
    if (step.rebaseAfter.length > 0) {
        return phrase("reviews.queue.why.rebaseAfter", { prs: prsPhrase(step.rebaseAfter) });
    }
    if (step.before.length > 0) {
        return phrase("reviews.queue.why.before", { prs: prsPhrase(step.before) });
    }
    if ((partners ?? []).length === 0) {
        return phrase("reviews.queue.why.noImpact");
    }
    return null;
}

// conflictPartners: the listed PRs a PR conflicts with, either way (#1201 ↔ #1202), with the conflicting paths: those
// its merge would put in conflict and those whose merge would put it in conflict.
export function conflictPartners(forecast: Forecast, pr: ReviewPr, listed: readonly ReviewPr[]): ConflictPartner[] {
    if (forecast?.state !== "ready" || pr == null) {
        return [];
    }
    const all = [...listed];
    const draftOf = new Map(all.map((p) => [p.number, !!p.draft]));
    const rtn = new Map<number, ConflictPartner>();
    const add = (number: number, paths: string[], pathcount: number) => {
        if (number === pr.number || !draftOf.has(number)) {
            return;
        }
        const known = rtn.get(number);
        if (known == null) {
            rtn.set(number, {
                number,
                draft: draftOf.get(number),
                paths: [...(paths ?? [])],
                pathcount: pathcount ?? 0,
            });
            return;
        }
        const merged = [...new Set([...known.paths, ...(paths ?? [])])];
        known.paths = merged;
        known.pathcount = Math.max(known.pathcount, pathcount ?? 0, merged.length);
    };
    for (const impact of impactsOf(forecast, pr, all)) {
        add(impact.number, impact.paths, impact.pathcount);
    }
    for (const by of impactedBy(forecast, pr, all)) {
        add(by.number, by.paths, by.pathcount);
    }
    return [...rtn.values()].sort((a, b) => a.number - b.number);
}

function partnersPaths(partners: ConflictPartner[]): { paths: string[]; count: number } {
    const paths = [...new Set(partners.flatMap((p) => p.paths))];
    const count = Math.max(paths.length, ...partners.map((p) => p.pathcount));
    return { paths, count };
}

// conflictFact: the card's facts line at rest: "same lines as #1202 and the draft #1208: src/theme.ts".
export function conflictFact(partners: ConflictPartner[]): Phrase {
    if (partners == null || partners.length === 0) {
        return null;
    }
    const { paths, count } = partnersPaths(partners);
    const prs = listPhrase(partners.map((p) => prPhrase(p.number, p.draft)));
    if (paths.length === 0) {
        return phrase("reviews.queue.fact.noPaths", { prs });
    }
    return phrase("reviews.queue.fact.sameLines", { prs, paths: pathsText(paths, count, 2) });
}

// conflictTag: on a card linked to the active one, "⇄ conflict with #1201 · src/theme.ts".
export function conflictTag(source: number, partner: ConflictPartner): Phrase {
    if (partner == null) {
        return null;
    }
    if (partner.paths.length === 0) {
        return phrase("reviews.queue.tag.noPaths", { number: source });
    }
    return phrase("reviews.queue.tag.paths", {
        number: source,
        paths: pathsText(partner.paths, partner.pathcount, 1),
    });
}

// What a card shows of its conflicts: its facts line at rest, and its part while a card is hovered or focused (the
// source framed, the linked cards tinted with their tag).
export type CardRelation = { fact: Phrase; role: "source" | "linked" | null; tag: Phrase };

export type ListRelations = {
    cards: Record<number, CardRelation>;
    // The active card's partners, which the lines and the edge lines reach.
    partners: ConflictPartner[];
    // Every card's own partners.
    byCard: Record<number, ConflictPartner[]>;
};

// cardRelations: every listed card's relation, for the active (hovered or focused) card.
export function cardRelations(forecast: Forecast, listed: readonly ReviewPr[], active: number): ListRelations {
    const cards: Record<number, CardRelation> = {};
    const byCard: Record<number, ConflictPartner[]> = {};
    for (const pr of listed) {
        byCard[pr.number] = conflictPartners(forecast, pr, listed);
    }
    const partners = active != null ? (byCard[active] ?? []) : [];
    for (const pr of listed) {
        const own = byCard[pr.number];
        const asPartner = partners.find((p) => p.number === pr.number);
        const role =
            active == null || partners.length === 0
                ? null
                : pr.number === active
                  ? "source"
                  : asPartner
                    ? "linked"
                    : null;
        cards[pr.number] = {
            fact: conflictFact(own),
            role,
            tag: role === "linked" ? conflictTag(active, asPartner) : null,
        };
    }
    return { cards, partners, byCard };
}

// edgeLine: a linked card off the visible part of the list, or in a folded section: "↓ the draft #1208, lower down ·
// src/theme.ts".
export function edgeLine(partner: ConflictPartner, where: "up" | "down" | "hidden"): Phrase {
    if (partner == null) {
        return null;
    }
    const pr = prPhrase(partner.number, partner.draft);
    const paths = partner.paths.length > 0 ? pathsText(partner.paths, partner.pathcount, 1) : "";
    const key = `reviews.queue.edge.${where}${paths ? "" : "NoPaths"}`;
    return phrase(key, { pr, paths });
}

// ---- After a merge (FR-REV-024) ----

// What the list remembers of the queue between two reads: its steps, and the PRs each step's merge would put in
// conflict, with the paths.
export type QueueMemory = {
    numbers: number[];
    impacts: Record<number, { number: number; paths: string[]; pathcount: number }[]>;
};

export type AfterMergeNeed = { number: number; after: number; paths: string[]; pathcount: number };

// The status line after a merge: the PRs merged, those that now need a rebase, and the read that showed it (the
// merged steps stay struck through while that read is the list's).
export type AfterMerge = { merged: number[]; needs: AfterMergeNeed[]; read: number; failures?: Phrase[] };

export function queueMemory(queue: MergeQueue, forecast: Forecast, listed: readonly ReviewPr[]): QueueMemory {
    if (queue == null || !queue.usable) {
        return null;
    }
    const all = [...listed];
    const impacts: QueueMemory["impacts"] = {};
    const numbers: number[] = [];
    for (const s of queue.steps) {
        if (s.merged) {
            continue;
        }
        numbers.push(s.number);
        const pr = all.find((p) => p.number === s.number);
        impacts[s.number] = impactsOf(forecast, pr, all).map((i) => ({
            number: i.number,
            paths: i.paths ?? [],
            pathcount: i.pathcount ?? 0,
        }));
    }
    return { numbers, impacts };
}

// afterMergeOf: the steps of the remembered queue the new read lists as merged, and the PRs still waiting for review
// their merge puts in conflict (drafts left to their own agents, and those the running merge queue already takes
// left out). null when no step was merged.
export function afterMergeOf(
    memory: QueueMemory,
    answer: ReviewsAnswer,
    listed: readonly ReviewPr[],
    takenByQueue?: (number: number) => boolean
): AfterMerge {
    if (memory == null || answer == null) {
        return null;
    }
    const open = new Set(listed.filter((pr) => !pr.draft).map((pr) => pr.number));
    const listedNumbers = new Set(listed.map((pr) => pr.number));
    const mergedNow = new Set((answer.merged ?? []).map((pr) => pr.number));
    const merged = memory.numbers.filter((n) => !listedNumbers.has(n) && mergedNow.has(n));
    if (merged.length === 0) {
        return null;
    }
    const needs: AfterMergeNeed[] = [];
    for (const m of merged) {
        for (const impact of memory.impacts[m] ?? []) {
            if (!open.has(impact.number) || needs.some((n) => n.number === impact.number)) {
                continue;
            }
            if (takenByQueue?.(impact.number)) {
                continue;
            }
            needs.push({ number: impact.number, after: m, paths: impact.paths, pathcount: impact.pathcount });
        }
    }
    return { merged, needs, read: answer.githubat ?? 0 };
}

// forgetMerged: the memory once a merge was reported, so the same merge is not reported again while the forecast
// computes on the new base.
export function forgetMerged(memory: QueueMemory, merged: readonly number[]): QueueMemory {
    if (memory == null) {
        return null;
    }
    const gone = new Set(merged);
    return { numbers: memory.numbers.filter((n) => !gone.has(n)), impacts: memory.impacts };
}

// joinAfterMerge: a second merge before the line was closed adds to it.
export function joinAfterMerge(shown: AfterMerge, next: AfterMerge): AfterMerge {
    if (shown == null) {
        return next;
    }
    if (next == null) {
        return shown;
    }
    const merged = [...new Set([...shown.merged, ...next.merged])];
    const needs = [...shown.needs, ...next.needs].filter(
        (n, i, all) => !merged.includes(n.number) && all.findIndex((o) => o.number === n.number) === i
    );
    return { merged, needs, read: next.read };
}

// afterMergeText: "✓ #1206 and #1201 merged. #1202 touches the same lines as #1201: it now needs a rebase".
export function afterMergeText(after: AfterMerge): Phrase {
    if (after == null) {
        return null;
    }
    const merged = phrase(after.merged.length === 1 ? "reviews.queue.after.mergedOne" : "reviews.queue.after.merged", {
        prs: prsPhrase(after.merged),
    });
    if ((after.failures?.length ?? 0) > 0) {
        return joinPhrases([merged, ...after.failures]);
    }
    if (after.needs.length === 0) {
        return joinPhrases([merged, phrase("reviews.queue.after.nothing")]);
    }
    const lines = after.needs.map((n) =>
        phrase(n.paths.length > 0 ? "reviews.queue.after.needs" : "reviews.queue.after.needsNoPaths", {
            number: n.number,
            after: n.after,
        })
    );
    return joinPhrases([merged, ...lines]);
}
