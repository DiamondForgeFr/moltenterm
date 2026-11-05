// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergedSection } from "./reviews-merged";
import { MergedOpenPref, notesByPr, ReviewMergedPr, shipsLabel } from "./reviews-merged-model";
import { ReviewsAnswer } from "./reviews-model";
import { ReviewsFolds, ReviewsFoldsKey } from "./reviews-order-store";

// The settings the page holds, as the app's global atoms give them once initialised.
vi.mock("@/app/store/global", async (importOriginal) => {
    const { atom } = await import("jotai");
    const fullConfigAtom = atom(null);
    const settingsAtom = atom((get) => (get(fullConfigAtom) as any)?.settings ?? {});
    return {
        ...(await importOriginal<object>()),
        atoms: { fullConfigAtom, settingsAtom },
        getSettingsKeyAtom: (key: string) => atom((get) => (get(settingsAtom) as any)[key]),
    };
});

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
        ReviewsFolds.resetInstance();
        globalStore.set(atoms.fullConfigAtom, null);
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
        expect(html.indexOf("reviews-merged-all")).toBeLessThan(html.indexOf("reviews-merged-row"));
        expect(html).not.toContain("merged-history");
    });

    it("opens the ticket, else the pull request, from a row's number (#1921)", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        const html = renderToStaticMarkup(
            <MergedSection
                answer={answer([merged(7, { ticket: 801, ships: "next" }), merged(6, { ships: "next" })])}
                onShowNotes={() => {}}
            />
        );
        const numbers = html.match(/<button[^>]*data-testid="reviews-merged-number"[^>]*>/g);
        expect(numbers).toHaveLength(2);
        expect(numbers[0]).toContain('aria-label="Open ticket #801"');
        expect(numbers[0]).toContain('data-url="https://github.com/a/b/issues/801"');
        expect(numbers[1]).toContain('aria-label="Open pull request #6"');
        expect(numbers[1]).toContain('data-url="https://github.com/a/b/pull/6"');
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
        const save = vi.spyOn(RpcApi, "SetConfigCommand").mockResolvedValue(undefined);
        MergedOpenPref.getInstance().set(false);
        expect(save.mock.calls[0]?.[1]).toEqual({ [ReviewsFoldsKey]: { merged: false } });
        save.mockRestore();
        // A new page reads it from the settings (#1758).
        globalStore.set(atoms.fullConfigAtom, {
            settings: { [ReviewsFoldsKey]: { merged: false } },
        } as unknown as FullConfigType);
        MergedOpenPref.resetInstance();
        ReviewsFolds.resetInstance();
        expect(globalStore.get(MergedOpenPref.getInstance().openAtom)).toBe(false);
        const html = renderToStaticMarkup(<MergedSection answer={answer([merged(7)])} onShowNotes={() => {}} />);
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain("reviews-merged-row");
        // The whole history stays one click away with the section collapsed (#1070).
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
