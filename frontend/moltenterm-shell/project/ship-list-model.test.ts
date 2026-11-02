// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { RawCommit } from "../mission/mission-model";
import type { MergedHistoryPr } from "../reviews/merged-history-model";
import { flatGroups, OrphansKey, parseSubject, pendingPrs, shipGroups, shipList } from "./ship-list-model";

let seq = 0;
function commit(subject: string, date = "2026-10-20T10:00:00Z"): RawCommit {
    seq++;
    return { sha: seq.toString(16).padStart(40, "0"), subject, date };
}

function pr(number: number, ticket: number, extra: Partial<MergedHistoryPr> = {}): MergedHistoryPr {
    return {
        number,
        title: `feat(#${ticket}): pr ${number}`,
        url: `https://github.com/acme/app/pull/${number}`,
        branch: `feature/${ticket}-x`,
        base: "develop",
        mergedat: "2026-10-20T12:00:00Z",
        ticket,
        ships: "next",
        ...extra,
    } as MergedHistoryPr;
}

const url = (n: number) => `https://github.com/acme/app/issues/${n}`;

describe("parseSubject", () => {
    it("reads the type, the ticket and the breaking mark", () => {
        expect(parseSubject("feat(#12): cards")).toEqual({ type: "feat", ticket: 12, text: "cards", breaking: false });
        expect(parseSubject("fix(#3)!: menu")).toMatchObject({ type: "fix", ticket: 3, breaking: true });
        expect(parseSubject("Merge branch 'develop'")).toMatchObject({ type: "", ticket: 0 });
    });
});

describe("shipGroups", () => {
    it("groups commits by ticket and puts the commits without one in their own group, last", () => {
        const groups = shipGroups(
            [commit("feat(#1): a"), commit("test(#1): b"), commit("chore: bump"), commit("fix(#2): c")],
            [],
            url
        );
        expect(groups.map((g) => g.key)).toEqual(["ticket:1", "ticket:2", OrphansKey]);
        expect(groups[0].commits).toHaveLength(2);
        expect(groups[0].kind).toBe("feat");
        expect(groups[0].url).toBe(url(1));
        expect(groups[1].kind).toBe("fix");
        expect(groups[2].commits.map((c) => c.subject)).toEqual(["chore: bump"]);
    });

    it("nests tickets along their parents: Epic > Story > Task, a parent without change heads its children", () => {
        const epic = { number: 10, title: "Epic", type: "Epic", url: url(10) };
        const story = { number: 20, title: "Story", type: "Story", url: url(20) };
        const groups = shipGroups(
            [commit("feat(#20): story work"), commit("feat(#30): task work"), commit("fix(#31): task fix")],
            [
                pr(1, 20, { tickettitle: "Story", tickettype: "Story", ticketparents: [epic] }),
                pr(2, 30, { tickettitle: "Task A", tickettype: "Task", ticketparents: [story, epic] }),
                pr(3, 31, { tickettitle: "Task B", tickettype: "Task", ticketparents: [{ number: 30 }, story, epic] }),
            ],
            url
        );
        expect(groups).toHaveLength(1);
        const top = groups[0];
        expect(top).toMatchObject({ ticket: 10, header: true, tickettype: "Epic", title: "Epic" });
        expect(top.children.map((g) => g.ticket)).toEqual([20]);
        const storyGroup = top.children[0];
        expect(storyGroup.header).toBe(false);
        expect(storyGroup.children.map((g) => g.ticket)).toEqual([30]);
        // Task > Task
        expect(storyGroup.children[0].children.map((g) => g.ticket)).toEqual([31]);
        expect(flatGroups(groups)).toHaveLength(4);
    });

    it("puts behaviour changes first, rolled up from the children", () => {
        const groups = shipGroups(
            [commit("feat(#1): new", "2026-10-22T00:00:00Z"), commit("fix(#2): fix"), commit("chore(#3): tidy")],
            [
                pr(5, 3, {
                    title: "chore(#3): tidy",
                    ticketparents: [{ number: 9, title: "Epic" }],
                    behaviour: { from: "section", verify: "Escape closes" },
                }),
            ],
            url
        );
        expect(groups.map((g) => g.ticket)).toEqual([9, 1, 2]);
        expect(groups[0].flagged).toBe(true);
        expect(groups[0].flag).toBeNull();
        expect(groups[0].children[0].flag).toEqual({ from: "section", verify: "Escape closes" });
    });

    it("flags a ! commit even without GitHub", () => {
        const groups = shipGroups([commit("feat(#1): a"), commit("fix(#2)!: renamed setting")], [], url);
        expect(groups[0]).toMatchObject({ ticket: 2, flagged: true, flag: { from: "breaking" } });
    });

    it("takes the ticket's title, type and the PR summary from the history", () => {
        const [g] = shipGroups(
            [commit("feat(#4): wip")],
            [pr(7, 4, { tickettitle: "Ship list", tickettype: "Story", ticketurl: "u4", summary: "One line." })],
            url
        );
        expect(g).toMatchObject({
            title: "Ship list",
            tickettype: "Story",
            url: "u4",
            summary: "One line.",
            type: "feat",
        });
    });
});

describe("pendingPrs", () => {
    it("keeps the PRs of the next version, squashed pending ones and candidates of a pending ticket", () => {
        const c = commit("fix(#8): x");
        const prs = [
            pr(1, 1),
            pr(2, 2, { ships: "tag", shipsin: "v0.9.0" }),
            pr(3, 8, { ships: "tag", shipsin: "v1.0.0-6" }),
            pr(4, 9, { ships: "tag", shipsin: "v0.9.0", mergeoid: c.sha }),
            pr(5, 8, { ships: "branch", shipsin: "main" }),
        ];
        expect(pendingPrs(prs, [c]).map((p) => p.number)).toEqual([1, 3, 4]);
    });
});

describe("shipList", () => {
    it("falls back to git alone without GitHub", () => {
        const list = shipList([commit("feat(#1): a"), commit("docs: readme")], { error: "gh is not logged in" }, url);
        expect(list.gitOnly).toBe(true);
        expect(list.groups.map((g) => g.key)).toEqual(["ticket:1", OrphansKey]);
        expect(list.groups[0].prs).toEqual([]);
        expect(shipList([], null).gitOnly).toBe(true);
        expect(shipList([], { prs: [] }).gitOnly).toBe(false);
    });
});
