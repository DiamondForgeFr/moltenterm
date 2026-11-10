// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-REV-034, FR-REV-035 (#2174): who owns the work, what a view's filter covers, what it hides and what of that waits
// for the developer, which agent to propose, how work in progress groups under its lead.

import { describe, expect, it } from "vitest";
import type { ChainEdge } from "../agent-chain-store";
import type { AgentStatesData } from "../agent-state-model";
import type { CardState } from "./reviews-card-model";
import type { ReviewPr } from "./reviews-model";
import {
    agentOwner,
    branchOwner,
    chainLeadOf,
    chainRoot,
    chainSubs,
    effectiveScope,
    foldName,
    groupByLead,
    initialScope,
    inScope,
    NoOwnersFilter,
    ownerFacts,
    ownersFilterFacts,
    ownersHeaderLabel,
    ownersHeaderParts,
    ownersNamesFit,
    ownersOf,
    presentAgentNames,
    proposals,
    prOwner,
    readScope,
    sameOwnersFilterFacts,
    scopeAdd,
    scopeChips,
    scopeIgnore,
    scopeNames,
    scopeOn,
    scopeOnly,
    scopeRemove,
    scopeSplit,
    shortOwnerName,
    waitsForYou,
} from "./reviews-owners-model";
import type { BranchAgent, UpcomingAnswer } from "./reviews-upcoming-model";

function pr(number: number, signer?: string, branch = `feature/${number}-x`): ReviewPr {
    return {
        number,
        branch,
        agents: signer ? [{ firstname: signer, agent: "Claude Code" }] : undefined,
    } as ReviewPr;
}

function placed(branch: string, extra: Partial<BranchAgent>): BranchAgent {
    return { branch, worktree: "/w", kind: "panel", ...extra };
}

function upcoming(agents: BranchAgent[]): UpcomingAnswer {
    return { dir: "/p", branches: [], agents, at: 1 };
}

const Chain: ChainEdge[] = [
    { lead: "Flore", sub: "Hugo", at: 1 },
    { lead: "Hugo", sub: "Léa", at: 2 },
    { lead: "Jérôme", sub: "Zoé", at: 3 },
];

describe("the responsibility chain", () => {
    it("folds names without case, accents or spacing", () => {
        expect(foldName("  Jérôme ")).toBe("jerome");
        expect(foldName("Alice  2")).toBe("alice 2");
    });

    it("finds the sub-agents of a lead at any depth, once each", () => {
        expect(chainSubs(Chain, ["flore"])).toEqual(["Hugo", "Léa"]);
        expect(chainSubs(Chain, ["Flore", "Jerome"])).toEqual(["Hugo", "Zoé", "Léa"]);
        expect(chainSubs(Chain, ["Léa"])).toEqual([]);
    });

    it("survives a loop in a file edited by hand", () => {
        const loop: ChainEdge[] = [
            { lead: "A", sub: "B", at: 1 },
            { lead: "B", sub: "A", at: 2 },
        ];
        expect(chainSubs(loop, ["A"])).toEqual(["B"]);
        expect(["A", "B"]).toContain(chainRoot(loop, "A"));
    });

    it("names the lead that handed work last, and the top of a chain", () => {
        expect(chainLeadOf(Chain, "Léa")).toBe("Hugo");
        expect(chainRoot(Chain, "Léa")).toBe("Flore");
        expect(chainRoot(Chain, "Flore")).toBe("Flore");
        const twice: ChainEdge[] = [...Chain, { lead: "Jérôme", sub: "Hugo", at: 9 }];
        expect(chainLeadOf(twice, "Hugo")).toBe("Jérôme");
    });
});

describe("whose work a pull request or a branch is", () => {
    it("is the last agent that signed the PR", () => {
        expect(prOwner(pr(1, "Flore"), null)).toBe("Flore");
        const two = { ...pr(2), agents: [{ firstname: "Hugo" }, { firstname: "Flore" }] } as ReviewPr;
        expect(prOwner(two, null)).toBe("Hugo");
    });

    it("has none for a PR made by hand", () => {
        expect(prOwner(pr(3), upcoming([]))).toBe("");
        expect(prOwner(pr(3), null)).toBe("");
    });

    it("falls back to the agent working on the PR's branch when nothing is signed yet", () => {
        const up = upcoming([placed("feature/4-x", { firstname: "Léa" })]);
        expect(prOwner(pr(4), up)).toBe("Léa");
    });

    it("reads a CLI sub-agent as its session's work, and a visitor as nobody's", () => {
        expect(agentOwner(placed("b", { kind: "subagent", parentfirstname: "Flore" }))).toBe("Flore");
        expect(agentOwner(placed("b", { kind: "panel", firstname: "Flore", visiting: true }))).toBe("");
        expect(
            agentOwner(placed("b", { kind: "background", signed: true, firstname: "Hugo", parentfirstname: "Flore" }))
        ).toBe("Hugo");
        expect(agentOwner(placed("b", { kind: "background", parentfirstname: "Flore" }))).toBe("Flore");
    });

    it("gives a ticket without a PR to the agent of its branch", () => {
        const up = upcoming([
            placed("fix/7-a", { kind: "subagent", parentfirstname: "Flore" }),
            placed("fix/7-a", { kind: "panel", firstname: "Léa" }),
            placed("fix/8-b", { kind: "panel", firstname: "Zoé", visiting: true }),
        ]);
        expect(branchOwner(up, "fix/7-a")).toBe("Léa");
        expect(branchOwner(up, "fix/8-b")).toBe("");
        expect(branchOwner(up, "fix/9-c")).toBe("");
    });
});

describe("the view's filter", () => {
    it("is off without an agent: everything shows", () => {
        const scope = initialScope([]);
        expect(scopeOn(scope)).toBe(false);
        expect(scopeNames(scope, Chain)).toBeNull();
        expect(inScope("", null)).toBe(true);
        expect(inScope("Flore", null)).toBe(true);
    });

    it("follows the agents of the view and their sub-agents", () => {
        const names = scopeNames(initialScope(["Flore"]), Chain);
        expect(inScope("Flore", names)).toBe(true);
        expect(inScope("léa", names)).toBe(true);
        expect(inScope("Zoé", names)).toBe(false);
        expect(inScope("", names)).toBe(false);
    });

    it("is the union of the agents' responsibilities", () => {
        const names = scopeNames(initialScope(["Flore", "Jérôme"]), Chain);
        for (const who of ["Flore", "Hugo", "Léa", "Jérôme", "Zoé"]) {
            expect(inScope(who, names)).toBe(true);
        }
        expect(inScope("Marc", names)).toBe(false);
    });

    it("counts the sub-agents each chip answers for", () => {
        expect(scopeChips(initialScope(["Flore", "Jérôme"]), Chain)).toEqual([
            { name: "Flore", subs: 2 },
            { name: "Jérôme", subs: 1 },
        ]);
    });

    it("hides what is outside it and says which pull requests", () => {
        const split = { ready: [pr(1, "Flore"), pr(2, "Marc"), pr(3)], drafts: [pr(4, "Hugo"), pr(5, "Zoé")] };
        const owners = (p: ReviewPr) => prOwner(p, null);
        const all = scopeSplit(split, null, owners);
        expect(all.shown).toBe(split);
        expect(all.hidden).toEqual([]);
        const scoped = scopeSplit(split, scopeNames(initialScope(["Flore"]), Chain), owners);
        expect(scoped.shown.ready.map((p) => p.number)).toEqual([1]);
        expect(scoped.shown.drafts.map((p) => p.number)).toEqual([4]);
        expect(scoped.hidden.map((p) => p.number)).toEqual([2, 3, 5]);
    });

    it("shows a hidden PR the developer asked to see", () => {
        const split = { ready: [pr(1, "Flore"), pr(2, "Marc")], drafts: [pr(3)] };
        const scoped = scopeSplit(
            split,
            scopeNames(initialScope(["Flore"]), Chain),
            (p) => prOwner(p, null),
            (p) => p.number === 2
        );
        expect(scoped.shown.ready.map((p) => p.number)).toEqual([1, 2]);
        expect(scoped.hidden.map((p) => p.number)).toEqual([3]);
    });

    it("signals a hidden PR that waits for the developer, not one that runs", () => {
        const card = (turn: CardState["turn"]) => ({ turn }) as CardState;
        expect(waitsForYou(card("yours"))).toBe(true);
        expect(waitsForYou(card("ready"))).toBe(true);
        expect(waitsForYou(card("waiting"))).toBe(false);
        expect(waitsForYou(card("agents"))).toBe(false);
        expect(waitsForYou(undefined)).toBe(false);
    });
});

describe("an agent that joins the view", () => {
    const scope = initialScope(["Flore"]);

    it("is proposed, never applied", () => {
        expect(proposals(["Flore", "Jérôme"], scope, Chain)).toEqual(["Jérôme"]);
        expect(scopeNames(scope, Chain).has(foldName("Jérôme"))).toBe(false);
    });

    it("is not proposed when a followed agent already answers for it", () => {
        expect(proposals(["Flore", "Hugo", "Léa"], scope, Chain)).toEqual([]);
    });

    it("is proposed in a view that has no filter yet", () => {
        expect(proposals(["Flore"], initialScope([]), Chain)).toEqual(["Flore"]);
    });

    it("is added by Add, and not proposed again", () => {
        const added = scopeAdd(scope, "Jérôme");
        expect(added.agents).toEqual(["Flore", "Jérôme"]);
        expect(proposals(["Flore", "Jérôme"], added, Chain)).toEqual([]);
    });

    it("goes away for good when ignored, and changes nothing else", () => {
        const ignored = scopeIgnore(scope, "Jérôme");
        expect(ignored.agents).toEqual(["Flore"]);
        expect(proposals(["Flore", "Jérôme"], ignored, Chain)).toEqual([]);
        expect(proposals(["Flore", "Jérôme", "Marc"], ignored, Chain)).toEqual(["Marc"]);
    });

    it("is added again if the developer changes their mind", () => {
        const back = scopeAdd(scopeIgnore(scope, "Jérôme"), "Jérôme");
        expect(back.agents).toEqual(["Flore", "Jérôme"]);
        expect(back.ignored).toEqual([]);
    });
});

describe("changing the filter", () => {
    it("keeps an agent that left until the developer removes it", () => {
        const scope = initialScope(["Flore"]);
        expect(scopeNames(scope, Chain).has("flore")).toBe(true);
        expect(proposals([], scope, Chain)).toEqual([]);
    });

    it("removes a chip and does not propose it again while its agent is in the view", () => {
        const scope = initialScope(["Flore", "Jérôme"]);
        const next = scopeRemove(scope, ["Flore"], ["Flore", "Jérôme"]);
        expect(next.agents).toEqual(["Jérôme"]);
        expect(proposals(["Flore", "Jérôme"], next, Chain)).toEqual([]);
        const gone = scopeRemove(scope, ["Flore", "Jérôme"], []);
        expect(scopeOn(gone)).toBe(false);
        expect(gone.ignored).toEqual([]);
    });

    it("filters on one agent from the list", () => {
        const next = scopeOnly(initialScope(["Flore", "Jérôme"]), "Hugo");
        expect(next.agents).toEqual(["Hugo"]);
    });

    it("reads what a tab holds and nothing else", () => {
        expect(readScope(undefined)).toBeNull();
        expect(readScope("x")).toBeNull();
        expect(readScope([])).toBeNull();
        expect(readScope({ agents: ["Flore", " flore ", 3, ""], ignored: ["Marc"] })).toEqual({
            agents: ["Flore"],
            ignored: ["Marc"],
        });
        expect(readScope({})).toEqual({ agents: [], ignored: [] });
    });
});

describe("the agents of a view", () => {
    const info = (blockid: string, tabid: string, firstname: string, extra: Record<string, unknown> = {}) => ({
        blockid,
        tabid,
        firstname,
        version: 1,
        ...extra,
    });

    it("are the named agents running in the tab, oldest run first, each once", () => {
        const data = {
            states: {
                a: info("a", "t1", "Hugo", { started: 20 }),
                b: info("b", "t1", "Flore", { started: 10 }),
                c: info("c", "t2", "Marc", { started: 5 }),
                d: info("d", "t1", "", { started: 1 }),
                e: info("e", "t1", "Brokk", { own: true }),
                f: info("f", "t1", "flore", { started: 30 }),
            },
            versions: {},
        } as unknown as AgentStatesData;
        expect(presentAgentNames(data, "t1")).toEqual(["Flore", "Hugo"]);
        expect(presentAgentNames(data, "t3")).toEqual([]);
        expect(presentAgentNames(null, "t1")).toEqual([]);
    });
});

// FR-REV-034 AC1 and AC12 (#2207): the owners filter shows in the header only when there is something to filter.
describe("whether the owners filter shows", () => {
    const followed = initialScope(["Flore", "Jérôme"]);

    it("shows nothing in a view without an agent, and nothing is kept", () => {
        expect(ownersFilterFacts(initialScope([]), [], true)).toEqual({ shown: false, names: [] });
        expect(ownersFilterFacts(null, [], true)).toEqual({ shown: false, names: [] });
    });

    it("shows the filter, off, when an agent is in the view and no filter is kept", () => {
        expect(ownersFilterFacts(initialScope([]), ["Flore"], true)).toEqual({ shown: true, names: [] });
    });

    it("shows the agents the filter keeps", () => {
        expect(ownersFilterFacts(followed, ["Flore", "Jérôme"], true)).toEqual({
            shown: true,
            names: ["Flore", "Jérôme"],
        });
    });

    it("keeps the filter, and the way to take it off, for an agent that left the view", () => {
        expect(ownersFilterFacts(followed, [], true)).toEqual({ shown: true, names: ["Flore", "Jérôme"] });
    });

    it("shows nothing while the panel shows no list the filter applies to", () => {
        expect(ownersFilterFacts(followed, ["Flore"], false)).toEqual({ shown: false, names: [] });
    });

    it("tells a change of facts by value", () => {
        const a = ownersFilterFacts(followed, ["Flore"], true);
        expect(sameOwnersFilterFacts(a, ownersFilterFacts(followed, ["Hugo"], true))).toBe(true);
        expect(sameOwnersFilterFacts(a, ownersFilterFacts(initialScope(["Flore"]), ["Flore"], true))).toBe(false);
        expect(sameOwnersFilterFacts(a, ownersFilterFacts(followed, [], false))).toBe(false);
        expect(sameOwnersFilterFacts(NoOwnersFilter, ownersFilterFacts(initialScope([]), [], true))).toBe(true);
    });

    it("works from the saved filter, else from the agents there once their states are known", () => {
        const saved = initialScope(["Flore"]);
        expect(effectiveScope(saved, true, ["Hugo"])).toBe(saved);
        expect(effectiveScope(null, true, ["Hugo"])).toEqual({ agents: ["Hugo"], ignored: [] });
        expect(effectiveScope(null, false, ["Hugo"])).toEqual({ agents: [], ignored: [] });
    });
});

// FR-REV-034 AC12 (#2207): the header names the agents the filter keeps, as many as the room allows, 3 at least.
describe("the names the header says", () => {
    const names = ["Flore", "Bérénice", "Nathan", "Diane", "Hugo"];
    // 7 px a character, whatever the font: the rule is about counts, not about a font.
    const measure = (text: string) => [...text].length * 7;

    it("says them all, as one line, when the room holds them", () => {
        expect(ownersNamesFit(names, 400, measure)).toBe(5);
        expect(ownersHeaderLabel(names, 5)).toBe("Flore, Bérénice, Nathan, Diane, Hugo");
        expect(ownersHeaderParts(names, 5)).toEqual({ names: "Flore, Bérénice, Nathan, Diane, Hugo", more: 0 });
    });

    it("collapses the others to +N when the room is short", () => {
        expect(ownersNamesFit(names, 240, measure)).toBe(4);
        expect(ownersHeaderLabel(names, 4)).toBe("Flore, Bérénice, Nathan, Diane +1");
        expect(ownersHeaderParts(names, 3)).toEqual({ names: "Flore, Bérénice, Nathan", more: 2 });
    });

    it("grows and shrinks with the room, so a resize gives the count again", () => {
        const counts = [100, 190, 240, 260, 600].map((room) => ownersNamesFit(names, room, measure));
        expect(counts).toEqual([3, 3, 4, 5, 5]);
    });

    it("never says fewer than 3 while the filter keeps 3 or more, however short the room", () => {
        expect(ownersNamesFit(names, 0, measure)).toBe(3);
        expect(ownersNamesFit(names.slice(0, 3), 0, measure)).toBe(3);
        expect(ownersHeaderLabel(names, 3)).toBe("Flore, Bérénice, Nathan +2");
    });

    it("says every name when the filter keeps fewer than 3, with no +N", () => {
        expect(ownersNamesFit(names.slice(0, 2), 0, measure)).toBe(2);
        expect(ownersNamesFit(["Flore"], 0, measure)).toBe(1);
        expect(ownersHeaderLabel(names.slice(0, 2), 2)).toBe("Flore, Bérénice");
        expect(ownersNamesFit([], 100, measure)).toBe(0);
        expect(ownersHeaderLabel([], 0)).toBe("");
    });

    it("cuts a long name short so it cannot take the room of the others", () => {
        expect(shortOwnerName("Maximilienne-Alexandra")).toBe("Maximilienne-…");
        expect([...shortOwnerName("Maximilienne-Alexandra")]).toHaveLength(14);
        expect(shortOwnerName(" Flore ")).toBe("Flore");
        expect(ownersHeaderParts(["Maximilienne-Alexandra", "Flore"], 2).names).toBe("Maximilienne-…, Flore");
    });

    it("holds when asked for more names than there are", () => {
        expect(ownersHeaderParts(["Flore"], 9)).toEqual({ names: "Flore", more: 0 });
        expect(ownersHeaderParts(names, -1)).toEqual({ names: "", more: 5 });
    });
});

describe("the owners of a list", () => {
    it("lists each owner once with its count and sub-agents", () => {
        const got = ownersOf(["Flore", "Hugo", "Flore", "", "Léa", "Flore"], Chain);
        expect(got.map((o) => [o.name, o.count, o.subs])).toEqual([
            ["Flore", 3, 2],
            ["Hugo", 1, 1],
            ["Léa", 1, 0],
        ]);
    });

    it("tells a card its owner and the lead that handed it work", () => {
        expect(ownerFacts("Hugo", Chain)).toEqual({ name: "Hugo", lead: "Flore" });
        expect(ownerFacts("Flore", Chain)).toEqual({ name: "Flore", lead: "" });
        expect(ownerFacts("", Chain)).toBeNull();
    });

    it("groups work in progress under the lead at the top of the chain, the unowned last", () => {
        const rows = [
            { n: 1, o: "Léa" },
            { n: 2, o: "" },
            { n: 3, o: "Zoé" },
            { n: 4, o: "Flore" },
            { n: 5, o: "Hugo" },
        ];
        const groups = groupByLead(rows, (r) => r.o, Chain);
        expect(groups.map((g) => [g.lead, g.subs, g.rows.map((r) => r.n)])).toEqual([
            ["Flore", ["Léa", "Hugo"], [1, 4, 5]],
            ["Jérôme", ["Zoé"], [3]],
            ["", [], [2]],
        ]);
    });
});
