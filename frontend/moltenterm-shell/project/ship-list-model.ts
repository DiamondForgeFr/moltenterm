// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What would ship (#903, FR-MC-021): the changes waiting on the trunk, grouped by ticket along GitHub's parent links
// (Epic > Story or Task, Story > Task, Task > Task), behaviour changes first. The commits come from the snapshot the
// header already has; the PRs, tickets and parents from the merged history (#960) that Recently merged reads, never a
// second GitHub lookup. Without GitHub the groups come from the commit subjects alone. The groups are plain data so
// the list (ship-list.tsx) can show any set of tickets, a milestone's for #904.

import type { RawCommit } from "../mission/mission-model";
import type { BehaviourChange, HistoryTicketRef, MergedHistoryPr } from "../reviews/merged-history-model";

export type ShipKind = "feat" | "fix" | "other";

export const OrphansKey = "orphans";

export type ShipFlag = BehaviourChange;

export type ShipCommit = {
    sha: string;
    subject: string;
    // The subject without its type and ticket.
    text: string;
    date: string;
    // The conventional type ("feat", "chore"); "" when the subject has none.
    type: string;
    breaking: boolean;
};

export type ShipGroup = {
    key: string;
    // 0 for the commits without a ticket, and for a PR without one.
    ticket: number;
    title: string;
    url: string;
    // GitHub's issue type: Epic, Story, Task, Bug; "" when unknown.
    tickettype: string;
    // The conventional type of the change ("feat", "fix", "chore"…); "" when none is known.
    type: string;
    kind: ShipKind;
    summary: string;
    prs: MergedHistoryPr[];
    commits: ShipCommit[];
    // Its own behaviour-change flag, from a PR or a "!" commit.
    flag: ShipFlag;
    // It or a ticket under it is flagged.
    flagged: boolean;
    // A parent that has no change of its own: it only heads its children.
    header: boolean;
    children: ShipGroup[];
    // The newest commit or merge in the group or under it, for the order.
    newest: string;
};

export type ShipList = {
    groups: ShipGroup[];
    // The groups come from git alone (no GitHub data).
    gitOnly: boolean;
};

const SubjectRegex = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/;
const KindOrder: Record<ShipKind, number> = { feat: 0, fix: 1, other: 2 };

export function parseSubject(subject: string): { type: string; ticket: number; text: string; breaking: boolean } {
    const m = SubjectRegex.exec(subject ?? "");
    if (m == null) {
        const ticket = /#(\d+)/.exec(subject ?? "")?.[1];
        return { type: "", ticket: ticket ? Number(ticket) : 0, text: subject ?? "", breaking: false };
    }
    const ticket = /#(\d+)/.exec(m[2] ?? "")?.[1];
    return { type: m[1], ticket: ticket ? Number(ticket) : 0, text: m[4] || subject, breaking: m[3] === "!" };
}

export function kindOf(type: string): ShipKind {
    return type === "feat" || type === "fix" ? type : "other";
}

function toShipCommit(c: RawCommit): ShipCommit {
    const { type, text, breaking } = parseSubject(c.subject);
    return { sha: c.sha, subject: c.subject, text, date: c.date, type, breaking };
}

// pendingPrs: the history's PRs that ship with the next version, plus those whose merge commit is a pending one (a
// squash), or whose ticket has pending commits while they ship in no public release yet (a candidate tag only).
export function pendingPrs(prs: readonly MergedHistoryPr[], commits: readonly RawCommit[]): MergedHistoryPr[] {
    const shas = new Set((commits ?? []).map((c) => c.sha?.toLowerCase()));
    const tickets = new Set((commits ?? []).map((c) => parseSubject(c.subject).ticket).filter((n) => n > 0));
    return (prs ?? []).filter((pr) => {
        if (pr.ships === "next" || (pr.mergeoid && shas.has(pr.mergeoid.toLowerCase()))) {
            return true;
        }
        const candidate = pr.ships === "tag" && (pr.shipsin ?? "").includes("-");
        return pr.ticket > 0 && tickets.has(pr.ticket) && candidate;
    });
}

function later(a: string, b: string): string {
    return (a ?? "") > (b ?? "") ? a : b;
}

function makeGroup(key: string, ticket: number): ShipGroup {
    return {
        key,
        ticket,
        title: "",
        url: "",
        tickettype: "",
        type: "",
        kind: "other",
        summary: "",
        prs: [],
        commits: [],
        flag: null,
        flagged: false,
        header: false,
        children: [],
        newest: "",
    };
}

function finishGroup(g: ShipGroup, ticketUrl: (n: number) => string) {
    const pr = g.prs[0];
    const prType = pr ? parseSubject(pr.title) : null;
    const types = [prType?.type, ...g.commits.map((c) => c.type)].filter((t) => t);
    g.type = types[0] ?? "";
    g.kind = types.includes("feat") ? "feat" : types.includes("fix") ? "fix" : kindOf(g.type);
    g.title = pr?.tickettitle || (prType ? prType.text : "") || g.commits[0]?.text || g.title;
    g.url = pr?.ticketurl || g.url || (g.ticket > 0 ? ticketUrl(g.ticket) : "");
    g.tickettype = pr?.tickettype || g.tickettype;
    g.summary = g.prs.map((p) => p.summary).find((s) => s) ?? "";
    const breaking = g.commits.find((c) => c.breaking) ?? (prType?.breaking ? g.commits[0] : null);
    g.flag =
        g.prs.map((p) => p.behaviour).find((b) => b != null) ??
        (breaking != null || prType?.breaking ? { from: "breaking" } : null);
    for (const c of g.commits) {
        g.newest = later(g.newest, c.date);
    }
    for (const p of g.prs) {
        g.newest = later(g.newest, p.mergedat);
    }
}

function compareGroups(a: ShipGroup, b: ShipGroup): number {
    if (a.key === OrphansKey || b.key === OrphansKey) {
        return a.key === OrphansKey ? (b.key === OrphansKey ? 0 : 1) : -1;
    }
    if (a.flagged !== b.flagged) {
        return a.flagged ? -1 : 1;
    }
    if (a.kind !== b.kind) {
        return KindOrder[a.kind] - KindOrder[b.kind];
    }
    if (a.newest !== b.newest) {
        return a.newest > b.newest ? -1 : 1;
    }
    return b.ticket - a.ticket;
}

// Rolls each parent's flag, kind and date up from its children, then sorts every level.
function settle(groups: ShipGroup[]): ShipGroup[] {
    for (const g of groups) {
        settle(g.children);
        g.flagged = g.flag != null || g.children.some((c) => c.flagged);
        for (const c of g.children) {
            g.newest = later(g.newest, c.newest);
        }
        if (g.header && g.children.length > 0) {
            const kinds = g.children.map((c) => c.kind);
            g.kind = kinds.includes("feat") ? "feat" : kinds.includes("fix") ? "fix" : "other";
        }
    }
    return groups.sort(compareGroups);
}

// shipGroups groups the pending commits by their ticket, attaches the PRs, nests the tickets along their parents and
// puts the commits without a ticket in a group of their own, last.
export function shipGroups(
    commits: readonly RawCommit[],
    prs: readonly MergedHistoryPr[],
    ticketUrl: (n: number) => string = () => ""
): ShipGroup[] {
    const byKey = new Map<string, ShipGroup>();
    const order: ShipGroup[] = [];
    const groupFor = (key: string, ticket: number) => {
        let g = byKey.get(key);
        if (g == null) {
            g = makeGroup(key, ticket);
            byKey.set(key, g);
            order.push(g);
        }
        return g;
    };
    for (const c of commits ?? []) {
        const commit = toShipCommit(c);
        const ticket = parseSubject(c.subject).ticket;
        groupFor(ticket > 0 ? `ticket:${ticket}` : OrphansKey, ticket).commits.push(commit);
    }
    for (const pr of prs ?? []) {
        groupFor(pr.ticket > 0 ? `ticket:${pr.ticket}` : `pr:${pr.number}`, pr.ticket ?? 0).prs.push(pr);
    }
    for (const g of order) {
        g.prs.sort((a, b) => (b.mergedat ?? "").localeCompare(a.mergedat ?? ""));
        finishGroup(g, ticketUrl);
    }
    const orphans = byKey.get(OrphansKey);
    if (orphans != null) {
        orphans.title = "";
        orphans.url = "";
    }
    // The parents GitHub names, nearest first, from any PR of the ticket.
    const parentsOf = (g: ShipGroup): HistoryTicketRef[] =>
        g.prs.map((p) => p.ticketparents).find((ps) => ps != null && ps.length > 0) ?? [];
    const placed = new Set<ShipGroup>();
    const top: ShipGroup[] = [];
    for (const g of order) {
        if (g.key === OrphansKey || g.ticket === 0) {
            continue;
        }
        let child = g;
        for (const ref of parentsOf(g)) {
            if (ref?.number == null || ref.number <= 0 || ref.number === child.ticket) {
                break;
            }
            const key = `ticket:${ref.number}`;
            let parent = byKey.get(key);
            const known = parent != null;
            if (!known) {
                parent = makeGroup(key, ref.number);
                parent.header = true;
                parent.title = ref.title ?? "";
                parent.url = ref.url || ticketUrl(ref.number);
                parent.tickettype = ref.type ?? "";
                byKey.set(key, parent);
            } else if (!parent.tickettype && ref.type) {
                parent.tickettype = ref.type;
            }
            if (isAncestor(child, parent)) {
                break;
            }
            if (!parent.children.includes(child)) {
                parent.children.push(child);
            }
            placed.add(child);
            child = parent;
            // A parent with changes of its own places itself along its own parents.
            if (known) {
                break;
            }
        }
    }
    for (const g of [...byKey.values()]) {
        if (!placed.has(g)) {
            top.push(g);
        }
    }
    return settle(top);
}

function isAncestor(node: ShipGroup, candidate: ShipGroup): boolean {
    if (node === candidate) {
        return true;
    }
    return node.children.some((c) => isAncestor(c, candidate));
}

export function shipList(
    commits: readonly RawCommit[],
    history: { prs?: MergedHistoryPr[]; error?: string } | null,
    ticketUrl?: (n: number) => string
): ShipList {
    const gitOnly = history == null || !!history.error;
    const prs = gitOnly ? [] : pendingPrs(history.prs ?? [], commits);
    return { groups: shipGroups(commits, prs, ticketUrl), gitOnly };
}

// Every group of the tree, depth first: for counts and searches.
export function flatGroups(groups: readonly ShipGroup[]): ShipGroup[] {
    const rtn: ShipGroup[] = [];
    const walk = (list: readonly ShipGroup[]) => {
        for (const g of list) {
            rtn.push(g);
            walk(g.children);
        }
    };
    walk(groups);
    return rtn;
}
