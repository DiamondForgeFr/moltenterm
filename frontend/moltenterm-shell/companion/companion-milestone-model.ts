// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's Tasks block (FR-SHELL-018, #2392, #2416): the project's open milestones as wavesrv reads them
// (pkg/molten/milestones), one tab each, the agent's own task list, and the links from a task in progress to the agent
// working on it. A link is drawn only on a certain match, never guessed. Pure, so it is tested without a window.

import type { StateMarkKind } from "../state-mark";
import { CompanionSubagent, CompanionTodo, CompanionView } from "./companion-model";
import type { AgentRow, AgentRowState } from "./companion-recap-model";

// must match pkg/molten/milestones/milestones.go
export const MilestonesRoute = "molten:milestones";
export const MilestonesEvent = "molten:milestones";
export const MilestonesGetCommand = "moltenmilestonesget";
export const MaxMilestoneRows = 8;
// The sentences' setting and the developer's agreement the window records with it, which wavesrv requires: must match
// pkg/molten/milestones/route.go SummariesConsentKey and settings-catalog.ts ConfirmConsentKeys.
export const SummariesSettingKey = "companion:ticketsummaries";
export const SummariesConsentKey = "molten:ticketsummaries";

export type MilestoneState = "loading" | "ok" | "none" | "noforge";

// status: the ticket's board column as the project names it (#2418), absent when it is on no board.
export type MilestoneTicket = { number: number; title: string; url?: string; sentence?: string; status?: string };

export type MilestoneInfo = {
    number: number;
    title: string;
    url?: string;
    // Its issues, pull requests left out.
    open: number;
    closed: number;
    due?: number;
    remaining: number;
    tickets: MilestoneTicket[];
    // Its tickets were read: one with no open issue has none to read, one past the first tabs is read once selected.
    loaded?: boolean;
};

export type MilestonesView = {
    dir: string;
    state: MilestoneState;
    // Every open milestone, in the order of the tabs (the oldest version first).
    milestones?: MilestoneInfo[];
    // summaries: the developer turned the sentences on and confirmed it; phrasable: the project's agent can write them.
    summaries?: boolean;
    phrasable?: boolean;
    phrasing?: boolean;
    readat?: number;
};

// The one-time offer to explain each ticket in one sentence (#2392): shown above the milestone's tickets while the
// sentences are off, the project's agent can write them and the offer was never answered.
export function offersSummaries(view: MilestonesView, asked: boolean): boolean {
    return (
        view?.state === "ok" &&
        (view.milestones?.length ?? 0) > 0 &&
        view.phrasable === true &&
        !view.summaries &&
        !asked
    );
}

// The most tabs a companion shows (pkg/molten/milestones/forge.go ticketMilestones): the others are in the "+N" menu.
export const MaxMilestoneTabs = 4;

// A milestone whose work is all merged: no open issue left, at least one closed. It keeps its tab until its release
// closes the milestone (#2416); one with no issue at all has nothing to ship.
export function milestoneReady(m: MilestoneInfo): boolean {
    return m != null && (m.open ?? 0) <= 0 && (m.closed ?? 0) > 0;
}

// The tab shown: the one the developer chose while its milestone is still open, else the oldest open milestone (the
// release being prepared). None without a milestone.
export function chosenMilestone(list: MilestoneInfo[], chosen: number): MilestoneInfo {
    const milestones = list ?? [];
    return milestones.find((m) => m.number === chosen) ?? milestones[0] ?? null;
}

export type TabSplit = { shown: MilestoneInfo[]; more: MilestoneInfo[] };

// The tabs drawn and those in the "+N" menu. room is how many tabs fit (MaxMilestoneTabs at most, one at least): the
// first ones, in order; the selected one is always drawn, in the last place when it comes later, so what is shown is
// what is chosen.
export function splitTabs(list: MilestoneInfo[], selected: number, room: number): TabSplit {
    const milestones = list ?? [];
    const limit = Math.max(1, Math.min(MaxMilestoneTabs, Math.floor(room || 0), milestones.length));
    let shown = milestones.slice(0, limit);
    const picked = milestones.find((m) => m.number === selected);
    if (picked != null && !shown.includes(picked)) {
        shown = [...shown.slice(0, limit - 1), picked];
    }
    const place = new Map(milestones.map((m, i) => [m.number, i]));
    shown.sort((a, b) => place.get(a.number) - place.get(b.number));
    return { shown, more: milestones.filter((m) => !shown.includes(m)) };
}

// How many tabs fit in a width, from the length of their names: the chip's padding and border, its label at 11 px
// semibold with its tracking, and the small shape of a late or ready milestone. A row that does not fit whole leaves
// room for the "+N" chip. The tab row never wraps.
const TabLabelMax = 14;
const TabCharPx = 7.9;
const TabChipPx = 22;
const TabMarkPx = 13;
const TabGapPx = 6;
const TabMorePx = 38;

export function tabLabel(title: string): string {
    const text = (title ?? "").trim();
    return text.length > TabLabelMax ? `${text.slice(0, TabLabelMax - 1)}…` : text;
}

export function tabRoom(tabs: { label: string; marked: boolean }[], available: number): number {
    const widths = (tabs ?? []).map(
        (t) => TabChipPx + Math.min(t.label.length, TabLabelMax) * TabCharPx + (t.marked ? TabMarkPx : 0)
    );
    const fits = (budget: number) => {
        let used = 0;
        let count = 0;
        for (const w of widths) {
            const next = used + (count > 0 ? TabGapPx : 0) + w;
            if (next > budget) {
                break;
            }
            used = next;
            count++;
        }
        return count;
    };
    if (widths.length <= MaxMilestoneTabs && fits(available) === widths.length) {
        return widths.length;
    }
    return Math.max(1, Math.min(MaxMilestoneTabs, fits(available - TabMorePx - TabGapPx)));
}

export type Standing = "ready" | "late" | "";

// The heat of a milestone, always paired with a shape and a word: a finished one is ready (patina dot), a late one has
// work left past its due date (ember diamond). A finished milestone is never late: its work is done.
export function milestoneStanding(m: MilestoneInfo, now: number): Standing {
    if (m == null) {
        return "";
    }
    if (milestoneReady(m)) {
        return "ready";
    }
    return (m.open ?? 0) > 0 && daysLate(m.due, now) > 0 ? "late" : "";
}

// Whole days past the due date, from the day the forge holds (UTC); 0 when it is not due yet, due today or has none.
export function daysLate(due: number, now: number): number {
    if (!(due > 0)) {
        return 0;
    }
    const day = Date.parse(dayOf(due));
    const today = Date.parse(dayOf(now));
    return Math.max(0, Math.round((today - day) / 86400000));
}

export type MilestonesSignal = { dir: string; rev: number };

export function milestoneProgress(m: MilestoneInfo): { closed: number; total: number; ratio: number } {
    const closed = Math.max(0, m?.closed ?? 0);
    const total = closed + Math.max(0, m?.open ?? 0);
    return { closed, total, ratio: total > 0 ? closed / total : 0 };
}

export type DueText = { kind: "due" | "today" | "overdue"; date: string };

// The due date as the forge holds it: a day, kept in UTC so the date reads as it was set.
function dayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

export function dueText(due: number, now: number, locale: string): DueText {
    if (!(due > 0)) {
        return null;
    }
    const sameYear = new Date(due).getUTCFullYear() === new Date(now).getUTCFullYear();
    const date = new Date(due).toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        year: sameYear ? undefined : "numeric",
        timeZone: "UTC",
    });
    const day = dayOf(due);
    const today = dayOf(now);
    if (day === today) {
        return { kind: "today", date };
    }
    return { kind: day < today ? "overdue" : "due", date };
}

// The workflow's branch naming (feature/{N}-…, fix/{N}-…): pkg/molten/companion/tickets.go.
const BranchTicketRegex = /^(?:feature|fix)\/(\d{1,9})(?:-|$)/;
// A text that starts with its ticket: "#2390 smooth the switch".
const LeadingTicketRegex = /^\s*#(\d{1,9})\b/;

// A ticket named in a sentence: "#601", not "a#1" nor "&#39;" (pkg/molten/companion/tickets.go textTicketRegex).
const AnyTicketRegex = /(?:^|[^\w&#/])#(\d{1,9})\b/g;

// The ticket a text starts with; 0 when it does not start with one.
export function leadingTicket(text: string): number {
    const m = LeadingTicketRegex.exec(text ?? "");
    return m == null ? 0 : Number(m[1]);
}

// The ticket a description names (#2587): the one it starts with (the convention for agents that delegate), else the
// only ticket it names anywhere ("Analyse + plan #2587"). Two numbers or more are no certainty ("Port the fix from #2391
// to #2400"): 0, never a guess. Whether the number is a ticket of the milestone is the caller's check (ticketLinks).
export function namedTicket(text: string): number {
    const leading = leadingTicket(text);
    if (leading > 0) {
        return leading;
    }
    const numbers = new Set(Array.from((text ?? "").matchAll(AnyTicketRegex), (m) => Number(m[1])));
    return numbers.size === 1 ? [...numbers][0] : 0;
}

// The ticket an agent works on, when it is certain: its own branch names it, else its own description names it
// (namedTicket). Anything else is 0.
export function certainTicket(branch: string, description: string): number {
    const m = BranchTicketRegex.exec((branch ?? "").trim());
    if (m != null) {
        return Number(m[1]);
    }
    return namedTicket(description);
}

// kind and model: what a sub-agent is (its type and its model, as its row says it), which the "→" chip names it by
// (#2441): a sub-agent has no first name, and its description is the task the chip stands beside.
export type LinkAgent = {
    id: string;
    name: string;
    state: AgentRowState;
    ticket: number;
    description: string;
    kind?: string;
    model?: string;
};

// The ticket a sub-agent works on, the one answer the Agents at work block and the milestone's rows share (#2522): its
// own branch, then its own description, then the ticket the Integration panel placed it on (placedTickets: the
// branch of the worktree it works in, which its records may not name).
export function subagentTicket(
    branch: string,
    description: string,
    agentId: string,
    placed?: ReadonlyMap<string, number>
): number {
    return certainTicket(branch, description) || (agentId ? (placed?.get(agentId) ?? 0) : 0);
}

// The most levels of sub-agents' sub-agents followed (pkg/molten/companion/topics.go maxSubagentDepth).
const MaxSubagentDepth = 8;

// The ticket of each of the session's sub-agents, by row id (#2587): its own (subagentTicket), else, for a sub-agent's
// own sub-agent, the ticket of the sub-agent that started it, up its parents. The session's own sub-agents never take
// the main agent's.
export function subagentTickets(subs: CompanionSubagent[], placed?: ReadonlyMap<string, number>): Map<string, number> {
    const list = subs ?? [];
    const byAgent = new Map(list.filter((s) => s.agentid).map((s) => [s.agentid, s]));
    const tickets = new Map<string, number>();
    for (const sub of list) {
        let ticket = 0;
        let at = sub;
        for (let depth = 0; at != null && depth < MaxSubagentDepth; depth++) {
            ticket = subagentTicket(at.branch ?? "", (at.description ?? "").trim(), at.agentid, placed);
            if (ticket > 0 || !at.parentid) {
                break;
            }
            at = byAgent.get(at.parentid);
        }
        tickets.set(sub.id, ticket);
    }
    return tickets;
}

// The agents at work a task can link to: the main agent by its session's branch only (its topic is no certainty), each
// sub-agent by subagentTickets.
export function linkAgents(rows: AgentRow[], view: CompanionView, placed?: ReadonlyMap<string, number>): LinkAgent[] {
    const subs = new Map((view?.subagents ?? []).map((s) => [s.id, s]));
    const tickets = subagentTickets(view?.subagents, placed);
    return (rows ?? []).map((row) => {
        if (row.main) {
            return {
                id: row.id,
                name: row.name,
                state: row.state,
                ticket: certainTicket(view?.session?.branch, ""),
                description: "",
            };
        }
        const sub = subs.get(row.id);
        const description = (sub?.description ?? "").trim();
        return {
            id: row.id,
            name: row.name,
            state: row.state,
            ticket: tickets.get(row.id) ?? subagentTicket(row.branch, description, undefined, placed),
            description,
            kind: (sub?.kind ?? "").trim(),
            // The row's model and effort start with the model, its own or its parent's.
            model: (row.config ?? "").split(" · ")[0].trim(),
        };
    });
}

// A milestone ticket's agents: every agent whose certain ticket it is.
export function ticketLinks(tickets: MilestoneTicket[], agents: LinkAgent[]): Map<number, LinkAgent[]> {
    const numbers = new Set((tickets ?? []).map((t) => t.number));
    const links = new Map<number, LinkAgent[]>();
    for (const agent of agents ?? []) {
        if (!(agent.ticket > 0) || !numbers.has(agent.ticket)) {
            continue;
        }
        links.set(agent.ticket, [...(links.get(agent.ticket) ?? []), agent]);
    }
    return links;
}

function sameText(a: string, b: string): boolean {
    const norm = (s: string) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    return norm(a) !== "" && norm(a) === norm(b);
}

// The agent's own task in progress links only when it is certain (#2392): the one agent whose description is the
// task's text, else the one agent working on the ticket the task starts with. Never a guess from similar words.
export function todoLinks(todos: CompanionTodo[], agents: LinkAgent[]): Map<number, LinkAgent> {
    const links = new Map<number, LinkAgent>();
    (todos ?? []).forEach((todo, i) => {
        if (todo?.status !== "in_progress") {
            return;
        }
        const exact = (agents ?? []).filter((a) => sameText(a.description, todo.text));
        if (exact.length === 1) {
            links.set(i, exact[0]);
            return;
        }
        if (exact.length > 1) {
            return;
        }
        const named = leadingTicket(todo.text);
        if (named === 0) {
            return;
        }
        const working = (agents ?? []).filter((a) => a.ticket === named);
        if (working.length === 1) {
            links.set(i, working[0]);
        }
    });
    return links;
}

// The heat of a task's state, from the agent that works on it (FR-SHELL-116): working incandescent, waiting violet,
// failed ember; a task no agent works on is iron.
export function heatOf(state: AgentRowState): StateMarkKind {
    switch (state) {
        case "working":
        case "running":
            return "running";
        case "waiting":
            return "waiting";
        case "error":
            return "blocked";
    }
    return "draft";
}

// Ends of a link: a row of the Tasks block, an agent's card.
export function ticketEnd(n: number): string {
    return `ticket:${n}`;
}

export function todoEnd(i: number): string {
    return `todo:${i}`;
}

export function agentEnd(id: string): string {
    return `agent:${id}`;
}

export type DrawnLink = { id: string; from: string; to: string; heat: StateMarkKind };

export function drawnLinks(
    rows: MilestoneTicket[],
    tickets: Map<number, LinkAgent[]>,
    todos: Map<number, LinkAgent>
): DrawnLink[] {
    const links: DrawnLink[] = [];
    for (const row of rows ?? []) {
        for (const agent of tickets?.get(row.number) ?? []) {
            const from = ticketEnd(row.number);
            const to = agentEnd(agent.id);
            links.push({ id: `${from}>${to}`, from, to, heat: heatOf(agent.state) });
        }
    }
    for (const [i, agent] of todos ?? []) {
        const from = todoEnd(i);
        const to = agentEnd(agent.id);
        links.push({ id: `${from}>${to}`, from, to, heat: heatOf(agent.state) });
    }
    return links;
}

// The ends a pointer on one end, or on a line, lights: both ends of every link it belongs to.
export function hotEnds(links: DrawnLink[], hot: string): Set<string> {
    const ends = new Set<string>();
    if (!hot) {
        return ends;
    }
    for (const link of links ?? []) {
        if (link.id === hot || link.from === hot || link.to === hot) {
            ends.add(link.from);
            ends.add(link.to);
            ends.add(link.id);
        }
    }
    return ends;
}

export type Box = { left: number; top: number; right: number; bottom: number };

export type LinkPath = { id: string; heat: StateMarkKind; d: string; x1: number; y1: number; x2: number; y2: number };

// The line from a task's row (mid-height) to an agent's card (on its first line), between the edges that face each
// other, in the coordinates of the area that holds both: the agents stand on the right by default, on the left in a
// layout that puts them there. None when an end is not laid out or the two do not stand side by side.
export function linkPath(link: DrawnLink, from: Box, to: Box, origin: Box): LinkPath {
    if (from == null || to == null || origin == null) {
        return null;
    }
    if (from.right <= from.left || from.bottom <= from.top || to.right <= to.left || to.bottom <= to.top) {
        return null;
    }
    const toRight = to.left >= from.right;
    if (!toRight && to.right > from.left) {
        return null;
    }
    const side = toRight ? 1 : -1;
    const x1 = (toRight ? from.right : from.left) - origin.left + 2 * side;
    const y1 = (from.top + from.bottom) / 2 - origin.top;
    const x2 = (toRight ? to.left : to.right) - origin.left - 2 * side;
    const y2 = to.top + Math.min((to.bottom - to.top) / 2, 10) - origin.top;
    if ((x2 - x1) * side < 8) {
        return null;
    }
    const dx = Math.max(12, Math.abs(x2 - x1) / 2) * side;
    const r = (v: number) => Math.round(v * 10) / 10;
    return {
        id: link.id,
        heat: link.heat,
        d: `M ${r(x1)} ${r(y1)} C ${r(x1 + dx)} ${r(y1)}, ${r(x2 - dx)} ${r(y2)}, ${r(x2)} ${r(y2)}`,
        x1: r(x1),
        y1: r(y1),
        x2: r(x2),
        y2: r(y2),
    };
}

export function samePaths(a: LinkPath[], b: LinkPath[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((p, i) => p.id === b[i].id && p.d === b[i].d && p.heat === b[i].heat);
}

// The numbers whose sentences the companion needs: the rows it shows.
export function wantedTickets(rows: MilestoneTicket[]): number[] {
    return (rows ?? []).map((r) => r.number);
}
