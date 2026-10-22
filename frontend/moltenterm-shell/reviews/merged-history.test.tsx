// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("../review/review-notes", () => ({
    useReviewNotes: () => ({ notes: { repo: "a/b", notes: [{ id: "n1", pr: { number: 12 } }] }, error: null }),
}));
// The real frame portals into document.body; the history's content is what is checked here.
vi.mock("../dialog-frame", () => ({
    DialogFrame: ({ title, subtitle, children, buttons }: any) => (
        <div role="dialog" aria-label={title}>
            <div>{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import {
    byDay,
    filterChoices,
    filterHistory,
    historyEntries,
    keyOf,
    MergedHistoryPr,
    MergedHistoryStore,
    NoFilters,
} from "./merged-history-model";
import { MergedHistoryWindow } from "./merged-history-window";

function renderWindow(): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <MergedHistoryWindow dir="/p" repo="a/b" target="develop" onClose={() => {}} onShowNotes={() => {}} />
        </Provider>
    );
}

function pr(number: number, extra: Partial<MergedHistoryPr> = {}): MergedHistoryPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number + 100}-x`,
        base: "develop",
        author: "ag",
        mergedby: "boss",
        mergedat: new Date(Date.UTC(2026, 9, 20 - (number % 10), 12)).toISOString(),
        ticket: number + 100,
        ...extra,
    };
}

const Tags = ["v1.0.0-5", "v1.0.0-6", "v1.0.0", "v1.1.0-1"];

const History: MergedHistoryPr[] = [
    pr(20, { ships: "next", milestone: "1.1.0", tickettitle: "Merged history", tickettype: "Story" }),
    pr(19, { ships: "branch", shipsin: "main" }),
    pr(18, { ships: "tag", shipsin: "v1.1.0-1", agents: [{ firstname: "Valentin", agent: "Claude Code" }] }),
    pr(17, { ships: "tag", shipsin: "v1.0.0", milestone: "1.0.0" }),
    pr(16, { ships: "tag", shipsin: "v1.0.0-6", milestone: "1.0.0", reviewers: ["rev"] }),
    pr(15, { ships: "tag", shipsin: "v1.0.0-5" }),
    pr(14),
];

describe("merged history (#960)", () => {
    afterEach(() => MergedHistoryStore.resetInstance());

    it("groups by the version that ships each PR, candidates under their release", () => {
        const entries = historyEntries(History, History, Tags, "v");
        expect(entries.map((e) => e.key)).toEqual([
            "all",
            "next",
            "upcoming:1.1.0",
            "tag:v1.1.0-1",
            "tag:v1.0.0",
            "tag:v1.0.0-6",
            "tag:v1.0.0-5",
            "unknown",
        ]);
        expect(entries.find((e) => e.key === "next")).toMatchObject({ count: 2 });
        expect(entries.find((e) => e.key === "tag:v1.0.0-6")).toMatchObject({ nested: true, count: 1 });
        expect(entries.find((e) => e.key === "tag:v1.0.0")).toMatchObject({ nested: false });
    });

    it("groups a project without release tags by month (AC4)", () => {
        const prs = [pr(1, { mergedat: "2026-10-03T10:00:00Z" }), pr(2, { mergedat: "2026-08-03T10:00:00Z" })];
        expect(keyOf(prs[0], false)).toBe("month:2026-10");
        expect(historyEntries(prs, prs, [], "").map((e) => e.key)).toEqual(["all", "month:2026-10", "month:2026-08"]);
    });

    it("searches by text, ticket and PR number, and filters by milestone, person and dates (AC3)", () => {
        const numbers = (f: Partial<typeof NoFilters>) =>
            filterHistory(History, { ...NoFilters, ...f }).map((p) => p.number);
        expect(numbers({ text: "#116" })).toEqual([16]);
        expect(numbers({ text: "18" })).toEqual([18]);
        expect(numbers({ text: "merged HISTORY" })).toEqual([20]);
        expect(numbers({ text: "valentin" })).toEqual([18]);
        expect(numbers({ milestone: "1.0.0" })).toEqual([17, 16]);
        expect(numbers({ person: "rev" })).toEqual([16]);
        expect(numbers({ from: "2026-10-14", to: "2026-10-16" })).toEqual([16, 15, 14]);
        expect(filterChoices(History).milestones).toEqual(["1.0.0", "1.1.0"]);
        expect(filterChoices(History).people).toContain("Valentin");
    });

    it("groups the PRs shown by day", () => {
        const days = byDay([
            pr(1, { mergedat: "2026-10-03T10:00:00Z" }),
            pr(2, { mergedat: "2026-10-03T11:00:00Z" }),
            pr(3, { mergedat: "2026-10-01T11:00:00Z" }),
        ]);
        expect(days.map((d) => d.prs.length)).toEqual([2, 1]);
    });

    it("shows each PR with its ticket, version, people and links, 50 at a time (AC2)", () => {
        const prs = [...History];
        for (let i = 0; i < 60; i++) {
            prs.push(pr(1000 + i, { ships: "next", mergedat: "2026-09-01T10:00:00Z" }));
        }
        MergedHistoryStore.getInstance().store({
            dir: "/p",
            prs,
            total: prs.length,
            complete: true,
            tags: Tags,
            tagprefix: "v",
        });
        const html = renderWindow();
        expect(html).toContain("Merged pull requests");
        expect(html).toContain("a/b · merged into develop");
        expect(html.match(/data-testid="merged-history-row"/g)).toHaveLength(50);
        expect(html).toContain("Show 17 more (17 left)");
        expect(html).toContain("Ticket #120: Merged history");
        expect(html).toContain("Story");
        expect(html).toContain("in v1.1.0-1");
        expect(html).toContain("next release");
        expect(html).toContain("reviewed by rev");
        expect(html).toContain("Valentin");
        expect(html).toContain("Next version");
        expect(html).toContain("merged-history-ticket-link");
        expect(globalStore.get(MergedHistoryStore.getInstance().answersAtom)["/p"].prs).toHaveLength(67);
    });

    it("says it is reading, and what is left of a long history", () => {
        MergedHistoryStore.getInstance().store({ dir: "/p", prs: History, total: 300, loading: true, tags: Tags });
        const html = renderWindow();
        expect(html).toContain("Reading the merged pull requests: 7 of 300…");
    });
});
