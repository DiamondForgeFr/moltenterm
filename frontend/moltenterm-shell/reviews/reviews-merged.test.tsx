// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergedSection } from "./reviews-merged";
import { MergedOpenPref, MergedOpenStorageKey, notesByPr, ReviewMergedPr, shipsLabel } from "./reviews-merged-model";
import { ReviewsAnswer } from "./reviews-model";

vi.mock("../review/review-notes", () => ({
    useReviewNotes: () => ({
        notes: {
            repo: "a/b",
            notes: [
                { id: "n1", pr: { number: 7 } },
                { id: "n2", pr: { number: 7 } },
            ],
        },
        error: null,
        set: () => {},
    }),
}));

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        data,
    };
}

function merged(number: number, extra: Partial<ReviewMergedPr> = {}): ReviewMergedPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `fix/${number}-x`,
        base: "develop",
        author: "ag",
        mergedat: new Date(Date.now() - 3_600_000).toISOString(),
        mergedby: "boss",
        ...extra,
    };
}

function answer(rows: ReviewMergedPr[]): ReviewsAnswer {
    return { dir: "/p", state: "ok", repo: "a/b", target: "develop", ready: [], drafts: [], merged: rows };
}

describe("Recently merged (#843)", () => {
    afterEach(() => {
        MergedOpenPref.resetInstance();
        vi.unstubAllGlobals();
    });

    it("says where a PR ships", () => {
        expect(shipsLabel(merged(1, { ships: "tag", shipsin: "v1.0.0-4" }))).toMatchObject({
            label: "in v1.0.0-4",
            tone: "success",
        });
        expect(shipsLabel(merged(1, { ships: "next" }))?.label).toBe("next release");
        expect(shipsLabel(merged(1, { ships: "branch", shipsin: "main" }))?.label).toBe("on main");
        expect(shipsLabel(merged(1))).toBeNull();
    });

    it("counts the notes kept on each PR", () => {
        expect(notesByPr([{ pr: { number: 3 } }, { pr: { number: 3 } }, { pr: null }] as any)).toEqual({ 3: 2 });
    });

    it("groups the PRs by version, one compact row each (#1061)", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        const html = renderToStaticMarkup(
            <MergedSection
                answer={answer([
                    merged(7, {
                        ticket: 801,
                        title: "[#801] Terminal header icon",
                        ships: "next",
                        author: "boss",
                        agents: [{ firstname: "Paul", agent: "claude", model: "opus" }],
                    }),
                    merged(6, { ships: "tag", shipsin: "v1.0.0-4", author: "boss" }),
                    merged(5, { ships: "tag", shipsin: "v1.0.0-4", author: "ana" }),
                ])}
                onShowNotes={() => {}}
            />
        );
        expect(html).toContain("Recently merged");
        expect(html).toContain("In the next version");
        expect(html).toContain("Prepare the notes");
        expect(html).toContain("In v1.0.0-4");
        expect(html).toContain("Release notes");
        expect(html).toContain("#801");
        expect(html).toContain("Terminal header icon");
        expect(html).not.toContain("[#801]");
        expect(html).toContain("Paul · Opus");
        // The developer merged it: "by you" is not said; the developer's own PR without an agent says "you".
        expect(html).not.toContain("by boss");
        expect(html).toContain(">you<");
        expect(html).toContain("by ana");
        expect(html).not.toContain("next release");
        expect(html).toContain("✎");
        expect(html).toContain("1 h");
        expect(html.match(/data-testid="reviews-merged-row"/g)).toHaveLength(3);
        expect(html).not.toContain("reviews-merged-detail");
        // #960, #1070: the way to the whole history, which opens only when asked.
        expect(html).toContain("All merged pull requests");
        expect(html).not.toContain("merged-history");
    });

    it("shows six rows a group, then the rest in the history", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        const rows = Array.from({ length: 9 }, (_, i) => merged(100 + i, { ships: "next" }));
        const html = renderToStaticMarkup(<MergedSection answer={answer(rows)} onShowNotes={() => {}} />);
        expect(html.match(/data-testid="reviews-merged-row"/g)).toHaveLength(6);
        expect(html).toContain("… 3 more");
        expect(html).toContain("Show all");
    });

    it("remembers collapsed and expanded, else follows its default", () => {
        const storage = memoryStorage();
        vi.stubGlobal("localStorage", storage);
        expect(globalStore.get(MergedOpenPref.getInstance().openAtom)).toBeNull();
        const folded = renderToStaticMarkup(
            <MergedSection answer={answer([merged(7)])} onShowNotes={() => {}} defaultOpen={false} />
        );
        expect(folded).not.toContain("reviews-merged-row");
        MergedOpenPref.getInstance().set(false);
        expect(storage.data.get(MergedOpenStorageKey)).toBe("closed");
        MergedOpenPref.resetInstance();
        expect(globalStore.get(MergedOpenPref.getInstance().openAtom)).toBe(false);
        const html = renderToStaticMarkup(<MergedSection answer={answer([merged(7)])} onShowNotes={() => {}} />);
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain("reviews-merged-row");
        // #1070: the history stays reachable while folded.
        expect(html).toContain("reviews-merged-all");
    });

    it("tells an empty window", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        const html = renderToStaticMarkup(<MergedSection answer={answer([])} onShowNotes={() => {}} />);
        expect(html).toContain("No pull request merged into develop in the last 7 days.");
        // Older PRs stay reachable (#960).
        expect(html).toContain("reviews-merged-all");
    });
});
