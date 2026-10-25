// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews merge queue (#1062, FR-REV-023 to FR-REV-025): the suggested merge order (reviews-order-model.ts) as a
// numbered queue readable without hovering, the conflict relations between cards both ways, the words that give each
// card its place in the order's direction, and what changed after a merge. Pure: the view and the tests read the same
// queue. Sentences are phrases, worded where they show. The developer chooses which steps go into the group merge
// (#1108): the order is computed for the chosen ones, the others stay in the block to be put back. Every number shown
// is the card's own (#1108): its ticket, else its PR number.

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
    // The steps the developer took out of the group merge (#1108), in list order: no rank, shown after the steps.
    out?: number[];
    // The number each PR shows (#1108).
    ids?: ShownNumbers;
};

// ShownNumbers: by PR number, the number its card shows: its ticket, else its PR number (#1108).
export type ShownNumbers = Record<number, number>;

type NumberedPr = { number: number; ticket?: number };

export function shownNumberOf(pr: NumberedPr): number {
    return pr?.ticket || pr?.number;
}

export function shownNumbersOf(...lists: readonly (readonly NumberedPr[])[]): ShownNumbers {
    const rtn: ShownNumbers = {};
    for (const list of lists) {
        for (const pr of list ?? []) {
            rtn[pr.number] = shownNumberOf(pr);
        }
    }
    return rtn;
}

export function shownNumber(ids: ShownNumbers, number: number): number {
    return ids?.[number] ?? number;
}

// id: the number the partner's card shows (#1108).
export type ConflictPartner = { number: number; id?: number; draft: boolean; paths: string[]; pathcount: number };

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

// mergeQueue: the numbered queue for the PRs ready for review, from the forecast about every listed PR. taken: the
// steps the developer took out of the group merge (#1108); the order and its cost are the chosen ones'.
export function mergeQueue(
    forecast: Forecast,
    ready: readonly ReviewPr[],
    listed: readonly ReviewPr[],
    taken?: readonly number[]
): MergeQueue {
    const takenOut = new Set(taken ?? []);
    const all = queueCandidates(ready);
    const out = all.filter((pr) => takenOut.has(pr.number) && !conflictsBase(pr)).map((pr) => pr.number);
    const candidates = all.filter((pr) => !out.includes(pr.number));
    const ids = shownNumbersOf(listed, ready);
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
            out,
            ids,
        };
    }
    const rankOf = new Map(order.steps.map((s) => [s.number, s.rank]));
    const byRank = (numbers: number[]) => [...numbers].sort((a, b) => rankOf.get(a) - rankOf.get(b));
    const steps = order.steps.map((s) => ({
        number: s.number,
        rank: s.rank,
        rebase: s.rebase,
        wait: ciWaits(byNumber.get(s.number)),
        rebaseAfter: byRank(s.rebaseAfter),
        before: byRank(s.impactsLater),
    }));
    return {
        usable: true,
        steps,
        outside: order.outside.map((s) => s.number),
        cost: order.cost,
        listCost: order.currentCost,
        uptodate: order.uptodate,
        out,
        ids,
    };
}

// queueShown: the queue earns its block from QueueMinSteps steps, chosen or taken out (#1108: those taken out are put
// back from it).
export function queueShown(queue: MergeQueue): boolean {
    return queue != null && queueChosen(queue).length + (queue.out?.length ?? 0) >= QueueMinSteps;
}

// queueChosen: the steps going into the group merge, in the queue's order.
export function queueChosen(queue: MergeQueue): number[] {
    return (queue?.steps ?? []).filter((s) => !s.merged).map((s) => s.number);
}

// queueCanMerge: Merge in this order is offered from QueueMinSteps chosen steps; one alone merges by its Validate.
export function queueCanMerge(queue: MergeQueue): boolean {
    return queueChosen(queue).length >= QueueMinSteps;
}

// queueChoice: whether a PR is a step of the queue, chosen or taken out of the group merge; null when it is no step.
export function queueChoice(queue: MergeQueue, number: number): "in" | "out" | null {
    if (queue?.out?.includes(number)) {
        return "out";
    }
    return queueChosen(queue).includes(number) ? "in" : null;
}

// groupMergeAction: the card's "…" menu entry for its place in the group merge: the key of its label, and whether it
// puts the PR in. null for a PR that is no step.
export function groupMergeAction(choice: "in" | "out" | null): { labelKey: string; inGroup: boolean } {
    if (choice == null) {
        return null;
    }
    return choice === "in"
        ? { labelKey: "reviews.card.groupTakeOut", inGroup: false }
        : { labelKey: "reviews.card.groupAdd", inGroup: true };
}

// keptOut: the PRs taken out of the group merge that are still listed; the others are forgotten (#1108).
export function keptOut(out: readonly number[], listed: readonly ReviewPr[]): number[] {
    const numbers = new Set((listed ?? []).map((pr) => pr.number));
    return (out ?? []).filter((n) => numbers.has(n));
}

// withMerged: the steps merged since the last read, struck through at the head of the queue (FR-REV-024).
// ids: the numbers the merged PRs showed while listed.
export function withMerged(queue: MergeQueue, merged: readonly number[], ids?: ShownNumbers): MergeQueue {
    if (queue == null || merged == null || merged.length === 0) {
        return queue;
    }
    const struck = merged
        .filter((n) => !queue.steps.some((s) => s.number === n))
        .map((number) => ({ number, rank: 0, rebase: false, wait: false, rebaseAfter: [], before: [], merged: true }));
    return { ...queue, steps: [...struck, ...queue.steps], ids: { ...ids, ...queue.ids } };
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

// prPhrase: "#1091" or "the draft #1091", with the number the card shows (#1108).
export function prPhrase(number: number, draft = false, ids?: ShownNumbers): Phrase {
    return phrase(draft ? "reviews.queue.draftPr" : "reviews.queue.pr", { number: shownNumber(ids, number) });
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

function prsPhrase(numbers: number[], ids?: ShownNumbers): Phrase {
    return listPhrase(numbers.map((n) => prPhrase(n, false, ids)));
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
                    prs: prsPhrase(queue.outside, queue.ids),
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
        return phrase("reviews.queue.why.rebaseAfter", { prs: prsPhrase(step.rebaseAfter, queue.ids) });
    }
    if (step.before.length > 0) {
        return phrase("reviews.queue.why.before", { prs: prsPhrase(step.before, queue.ids) });
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
    const ids = shownNumbersOf(all);
    const rtn = new Map<number, ConflictPartner>();
    const add = (number: number, paths: string[], pathcount: number) => {
        if (number === pr.number || !draftOf.has(number)) {
            return;
        }
        const known = rtn.get(number);
        if (known == null) {
            rtn.set(number, {
                number,
                id: shownNumber(ids, number),
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
    const prs = listPhrase(partners.map((p) => prPhrase(p.id ?? p.number, p.draft)));
    if (paths.length === 0) {
        return phrase("reviews.queue.fact.noPaths", { prs });
    }
    return phrase("reviews.queue.fact.sameLines", { prs, paths: pathsText(paths, count, 2) });
}

// conflictTag: on a card linked to the active one, "⇄ conflict with #1201 · src/theme.ts"; source is the number the
// active card shows.
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
    const ids = shownNumbersOf(listed);
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
            tag: role === "linked" ? conflictTag(shownNumber(ids, active), asPartner) : null,
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
    const pr = prPhrase(partner.id ?? partner.number, partner.draft);
    const paths = partner.paths.length > 0 ? pathsText(partner.paths, partner.pathcount, 1) : "";
    const key = `reviews.queue.edge.${where}${paths ? "" : "NoPaths"}`;
    return phrase(key, { pr, paths });
}

// ---- After a merge (FR-REV-024) ----

// What the list remembers of the queue between two reads: its steps, and the PRs each step's merge would put in
// conflict, with the paths; and the number each listed PR showed, for the line once a merged one left the list.
export type QueueMemory = {
    numbers: number[];
    impacts: Record<number, { number: number; paths: string[]; pathcount: number }[]>;
    ids?: ShownNumbers;
};

export type AfterMergeNeed = { number: number; after: number; paths: string[]; pathcount: number };

// The status line after a merge: the PRs merged, those that now need a rebase, and the read that showed it (the
// merged steps stay struck through while that read is the list's).
export type AfterMerge = {
    merged: number[];
    needs: AfterMergeNeed[];
    read: number;
    failures?: Phrase[];
    ids?: ShownNumbers;
};

// queueMemory: the queue's steps, those taken out of the group merge included (they still merge by their Validate).
export function queueMemory(queue: MergeQueue, forecast: Forecast, listed: readonly ReviewPr[]): QueueMemory {
    if (queue == null || !queue.usable) {
        return null;
    }
    const all = [...listed];
    const impacts: QueueMemory["impacts"] = {};
    const numbers: number[] = [];
    const live = [...queue.steps.filter((s) => !s.merged).map((s) => s.number), ...(queue.out ?? [])];
    for (const number of live) {
        numbers.push(number);
        const pr = all.find((p) => p.number === number);
        impacts[number] = impactsOf(forecast, pr, all).map((i) => ({
            number: i.number,
            paths: i.paths ?? [],
            pathcount: i.pathcount ?? 0,
        }));
    }
    return { numbers, impacts, ids: { ...queue.ids, ...shownNumbersOf(all) } };
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
    return { merged, needs, read: answer.githubat ?? 0, ids: memory.ids };
}

// forgetMerged: the memory once a merge was reported, so the same merge is not reported again while the forecast
// computes on the new base.
export function forgetMerged(memory: QueueMemory, merged: readonly number[]): QueueMemory {
    if (memory == null) {
        return null;
    }
    const gone = new Set(merged);
    return { numbers: memory.numbers.filter((n) => !gone.has(n)), impacts: memory.impacts, ids: memory.ids };
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
    return { merged, needs, read: next.read, ids: { ...shown.ids, ...next.ids } };
}

// afterMergeText: "✓ #1206 and #1201 merged. #1202 touches the same lines as #1201: it now needs a rebase".
export function afterMergeText(after: AfterMerge): Phrase {
    if (after == null) {
        return null;
    }
    const merged = phrase(after.merged.length === 1 ? "reviews.queue.after.mergedOne" : "reviews.queue.after.merged", {
        prs: prsPhrase(after.merged, after.ids),
    });
    if ((after.failures?.length ?? 0) > 0) {
        return joinPhrases([merged, ...after.failures]);
    }
    if (after.needs.length === 0) {
        return joinPhrases([merged, phrase("reviews.queue.after.nothing")]);
    }
    const lines = after.needs.map((n) =>
        phrase(n.paths.length > 0 ? "reviews.queue.after.needs" : "reviews.queue.after.needsNoPaths", {
            number: shownNumber(after.ids, n.number),
            after: shownNumber(after.ids, n.after),
        })
    );
    return joinPhrases([merged, ...lines]);
}
