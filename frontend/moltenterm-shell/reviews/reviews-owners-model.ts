// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Integration follows the agents of its view (FR-REV-034, FR-REV-035, #2174). The pure rules, apart from the
// components: who owns a pull request or a branch, which agents a view's filter covers (its agents and their
// sub-agents at any depth, from the chain wavesrv keeps), what the filter hides and what of that waits for the
// developer, which agent to propose, and how the cards of work in progress group under their lead.

import type { ChainEdge } from "../agent-chain-store";
import type { AgentStatesData } from "../agent-state-model";
import type { CardState } from "./reviews-card-model";
import type { ReviewPr, ReviewsSplit } from "./reviews-model";
import type { BranchAgent, UpcomingAnswer } from "./reviews-upcoming-model";

// The view's filter, kept on its tab's meta: the agents it follows, and those the developer ignored for good.
export const ScopeMetaKey = "molten:integrationscope";
const MaxScopeNames = 24;
const MaxNameLength = 64;

export type OwnerScope = { agents: string[]; ignored: string[] };

// Folded names: the names the chain and the filter compare, without case, accents or spacing ("jerome" is Jérôme).
export function foldName(name: string): string {
    return (name ?? "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .split(/\s+/)
        .filter((w) => w !== "")
        .join(" ");
}

function cleanNames(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set<string>();
    const rtn: string[] = [];
    for (const item of raw) {
        const name = typeof item === "string" ? item.trim().slice(0, MaxNameLength) : "";
        const key = foldName(name);
        if (key === "" || seen.has(key)) {
            continue;
        }
        seen.add(key);
        rtn.push(name);
        if (rtn.length >= MaxScopeNames) {
            break;
        }
    }
    return rtn;
}

// readScope: the filter a tab's meta holds; null when the panel never opened in this view (nothing was written).
export function readScope(raw: unknown): OwnerScope {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    const value = raw as Record<string, unknown>;
    return { agents: cleanNames(value.agents), ignored: cleanNames(value.ignored) };
}

// initialScope: the panel opened in a view; it follows the agents already there, and none when there are none.
export function initialScope(present: readonly string[]): OwnerScope {
    return { agents: cleanNames(present), ignored: [] };
}

export function scopeOn(scope: OwnerScope): boolean {
    return (scope?.agents?.length ?? 0) > 0;
}

// chainSubs: the sub-agents of the leads at any depth, each once, the leads themselves left out.
export function chainSubs(edges: readonly ChainEdge[], leads: readonly string[]): string[] {
    const seen = new Set(leads.map(foldName));
    const rtn: string[] = [];
    const queue = [...leads];
    while (queue.length > 0) {
        const cur = foldName(queue.shift());
        for (const edge of edges ?? []) {
            const sub = foldName(edge.sub);
            if (foldName(edge.lead) !== cur || seen.has(sub)) {
                continue;
            }
            seen.add(sub);
            rtn.push(edge.sub);
            queue.push(edge.sub);
        }
    }
    return rtn;
}

// chainLeadOf: the lead that handed work to the agent last, "" when none did.
export function chainLeadOf(edges: readonly ChainEdge[], sub: string): string {
    let rtn = "";
    let at = -1;
    for (const edge of edges ?? []) {
        if (foldName(edge.sub) === foldName(sub) && (edge.at ?? 0) > at) {
            rtn = edge.lead;
            at = edge.at ?? 0;
        }
    }
    return rtn;
}

// chainRoot: the lead at the top of the agent's chain (the agent itself when nobody handed it work).
export function chainRoot(edges: readonly ChainEdge[], name: string): string {
    const seen = new Set<string>();
    let cur = name;
    while (!seen.has(foldName(cur))) {
        seen.add(foldName(cur));
        const lead = chainLeadOf(edges, cur);
        if (lead === "") {
            return cur;
        }
        cur = lead;
    }
    return name;
}

// ScopeNames: the folded names the filter covers; null when there is no filter, so everything shows.
export type ScopeNames = Set<string>;

export function scopeNames(scope: OwnerScope, edges: readonly ChainEdge[]): ScopeNames {
    if (!scopeOn(scope)) {
        return null;
    }
    return new Set([...scope.agents, ...chainSubs(edges, scope.agents)].map(foldName));
}

export type ScopeChip = { name: string; subs: number };

// scopeChips: one chip per followed agent, with how many sub-agents it answers for.
export function scopeChips(scope: OwnerScope, edges: readonly ChainEdge[]): ScopeChip[] {
    return (scope?.agents ?? []).map((name) => ({ name, subs: chainSubs(edges, [name]).length }));
}

// agentOwner: whose work a placed agent is. A panel works for itself, a sub-agent of the CLI for its session (it signs
// with the session's first name), a background agent for the session that started it unless its work is signed. A
// panel that only passed through the worktree works on nothing there.
export function agentOwner(agent: BranchAgent): string {
    if (agent == null || agent.visiting) {
        return "";
    }
    const own = (agent.firstname ?? "").trim();
    const parent = (agent.parentfirstname ?? "").trim();
    switch (agent.kind) {
        case "panel":
            return own;
        case "subagent":
            return parent;
        default:
            return agent.signed ? own || parent : parent;
    }
}

// branchOwner: the agent of a branch or worktree (FR-REV-035 AC2); a panel first, then whoever the other agents
// there answer to.
export function branchOwner(upcoming: UpcomingAnswer, branch: string): string {
    if (upcoming?.agents == null || !branch) {
        return "";
    }
    const here = upcoming.agents.filter((a) => a.branch === branch);
    const panels = here.filter((a) => a.kind === "panel");
    for (const a of [...panels, ...here.filter((a) => a.kind !== "panel")]) {
        const owner = agentOwner(a);
        if (owner !== "") {
            return owner;
        }
    }
    return "";
}

// prOwner: the last agent that signed the PR (its commits' trailers, then its body's block); an unsigned PR belongs
// to the agent working on its branch now, if any. A PR made by hand has none (FR-REV-035 AC1).
export function prOwner(pr: ReviewPr, upcoming: UpcomingAnswer): string {
    const signed = (pr.agents ?? []).map((a) => (a.firstname ?? "").trim()).find((n) => n !== "");
    return signed || branchOwner(upcoming, pr.branch);
}

export function inScope(owner: string, names: ScopeNames): boolean {
    return names == null || (owner !== "" && names.has(foldName(owner)));
}

export type ScopedSplit = { shown: ReviewsSplit; hidden: ReviewPr[] };

// scopeSplit: the list the filter keeps, and the PRs it hides. also: PRs outside the filter the developer asked to see
// ("2 others wait for you" → Show).
export function scopeSplit(
    split: ReviewsSplit,
    names: ScopeNames,
    ownerOf: (pr: ReviewPr) => string,
    also?: (pr: ReviewPr) => boolean
): ScopedSplit {
    if (names == null) {
        return { shown: split, hidden: [] };
    }
    const keep = (pr: ReviewPr) => inScope(ownerOf(pr), names) || (also?.(pr) ?? false);
    return {
        shown: { ready: split.ready.filter(keep), drafts: split.drafts.filter(keep) },
        hidden: [...split.ready, ...split.drafts].filter((pr) => !keep(pr)),
    };
}

// waitsForYou: a hidden PR the developer must act on or can merge now (FR-REV-034 AC6): its card's turn is "yours"
// (an agent stopped on a decision, red CI, a conflict nobody works on…) or "ready".
export function waitsForYou(card: CardState): boolean {
    return card != null && (card.turn === "yours" || card.turn === "ready");
}

// proposals: the agents of the view the filter does not cover yet and the developer did not ignore (FR-REV-034 AC4).
// An agent that is a sub-agent of a followed one is covered already: nothing to propose.
export function proposals(present: readonly string[], scope: OwnerScope, edges: readonly ChainEdge[]): string[] {
    const covered = new Set(
        [...(scope?.agents ?? []), ...chainSubs(edges, scope?.agents ?? []), ...(scope?.ignored ?? [])].map(foldName)
    );
    const rtn: string[] = [];
    const seen = new Set<string>();
    for (const name of present) {
        const key = foldName(name);
        if (key === "" || covered.has(key) || seen.has(key)) {
            continue;
        }
        seen.add(key);
        rtn.push(name);
    }
    return rtn;
}

// ScopeLabel: what a group action says of the list it acts on (FR-REV-034 AC8): whose it is, and how many others it
// leaves alone. null without a filter: the action reads as it always did.
export type ScopeLabel = { names: string[]; others: number };

export function scopeLabel(scope: OwnerScope, others: number): ScopeLabel {
    return scopeOn(scope) ? { names: [...scope.agents], others } : null;
}

export function scopeAdd(scope: OwnerScope, name: string): OwnerScope {
    const base = scope ?? { agents: [], ignored: [] };
    return {
        agents: cleanNames([...base.agents, name]),
        ignored: base.ignored.filter((n) => foldName(n) !== foldName(name)),
    };
}

// scopeIgnore: the proposal goes away and does not come back for this view.
export function scopeIgnore(scope: OwnerScope, name: string): OwnerScope {
    const base = scope ?? { agents: [], ignored: [] };
    return { agents: base.agents, ignored: cleanNames([...base.ignored, name]) };
}

// scopeRemove: the developer takes agents off the filter. The ones in the view now are not proposed again: removing
// a chip is saying no to it.
export function scopeRemove(scope: OwnerScope, names: readonly string[], present: readonly string[]): OwnerScope {
    const base = scope ?? { agents: [], ignored: [] };
    const gone = new Set(names.map(foldName));
    const stillThere = (names as string[]).filter((n) => present.some((p) => foldName(p) === foldName(n)));
    return {
        agents: base.agents.filter((n) => !gone.has(foldName(n))),
        ignored: cleanNames([...base.ignored, ...stillThere]),
    };
}

// scopeOnly: "Filter on Flore" from an unfiltered list.
export function scopeOnly(scope: OwnerScope, name: string): OwnerScope {
    return scopeAdd({ agents: [], ignored: scope?.ignored ?? [] }, name);
}

// ownerNames: the owners of the PRs and branches listed, for the Owners menu, each once, the most work first.
export function ownersOf(
    owners: readonly string[],
    edges: readonly ChainEdge[]
): { name: string; count: number; subs: number }[] {
    const counts = new Map<string, { name: string; count: number }>();
    for (const owner of owners) {
        const key = foldName(owner);
        if (key === "") {
            continue;
        }
        const cur = counts.get(key) ?? { name: owner, count: 0 };
        cur.count++;
        counts.set(key, cur);
    }
    return [...counts.values()]
        .map((o) => ({ ...o, subs: chainSubs(edges, [o.name]).length }))
        .sort((a, b) => b.count - a.count || foldName(a.name).localeCompare(foldName(b.name)));
}

export const NoLead = "";

export type LeadGroup<T> = {
    // The lead at the top of the chain, "" for the work nobody owns.
    lead: string;
    // The other agents the group's rows belong to, in the order they appear.
    subs: string[];
    rows: T[];
};

// groupByLead: the rows of work in progress under the lead at the top of their owner's chain (FR-REV-034 AC7). The
// groups come in the order their first row appears; the work nobody owns is last.
export function groupByLead<T>(
    rows: readonly T[],
    ownerOf: (row: T) => string,
    edges: readonly ChainEdge[]
): LeadGroup<T>[] {
    const groups: LeadGroup<T>[] = [];
    const byKey = new Map<string, LeadGroup<T>>();
    for (const row of rows) {
        const owner = ownerOf(row);
        const lead = owner === "" ? NoLead : chainRoot(edges, owner);
        const key = foldName(lead);
        let group = byKey.get(key);
        if (group == null) {
            group = { lead, subs: [], rows: [] };
            byKey.set(key, group);
            groups.push(group);
        }
        group.rows.push(row);
        if (owner !== "" && foldName(owner) !== key && !group.subs.some((s) => foldName(s) === foldName(owner))) {
            group.subs.push(owner);
        }
    }
    return groups.sort((a, b) => Number(a.lead === NoLead) - Number(b.lead === NoLead));
}

// OwnerFacts: what a card shows of its owner: the agent, and the lead that handed it work when it is not the top.
export type OwnerFacts = { name: string; lead: string };

export function ownerFacts(owner: string, edges: readonly ChainEdge[]): OwnerFacts {
    if (owner === "") {
        return null;
    }
    return { name: owner, lead: chainLeadOf(edges, owner) };
}

// presentAgentNames: the agents running in the view (a tab), by first name, the oldest run first. Brokk's own session is
// no agent of a view, and an agent MoltenTerm has not named yet has nothing to follow.
export function presentAgentNames(data: AgentStatesData, tabId: string): string[] {
    const infos = Object.values(data?.states ?? {})
        .filter((s) => s.tabid === tabId && !s.own && (s.firstname ?? "").trim() !== "")
        .sort((a, b) => (a.started ?? 0) - (b.started ?? 0) || a.blockid.localeCompare(b.blockid));
    const seen = new Set<string>();
    const rtn: string[] = [];
    for (const info of infos) {
        const key = foldName(info.firstname);
        if (!seen.has(key)) {
            seen.add(key);
            rtn.push(info.firstname.trim());
        }
    }
    return rtn;
}
