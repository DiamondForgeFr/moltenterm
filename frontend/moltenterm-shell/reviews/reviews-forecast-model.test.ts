// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { listForecast } from "./reviews-forecast";
import {
    Forecast,
    forecastBaseOid,
    forecastKey,
    forecastMark,
    forecastRequestOf,
    forecastStatus,
    impactedBy,
    impactedNote,
    impactsOf,
    pathsText,
} from "./reviews-forecast-model";
import { ReviewPr, ReviewsAnswer } from "./reviews-model";

const Base = "b".repeat(40);
const head = (n: number) => String(n).repeat(40).slice(0, 40);

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid: head(number),
        baseoid: Base,
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "none", success: 0, failure: 0, pending: 0, checks: [] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

function answer(ready: ReviewPr[], drafts: ReviewPr[] = []): ReviewsAnswer {
    return { dir: "/p", state: "ok", repo: "a/b", target: "develop", ready, drafts };
}

// #1 would put #2 and #4 (a draft) in conflict, #2 would put #1 in conflict, #3 none.
function forecastOf(prs: ReviewPr[], extra: Partial<Forecast> = {}): Forecast {
    const req = forecastRequestOf(
        answer(
            prs.filter((p) => !p.draft),
            prs.filter((p) => p.draft)
        ),
        {
            ready: prs.filter((p) => !p.draft),
            drafts: prs.filter((p) => p.draft),
        }
    );
    return {
        dir: "/p",
        key: forecastKey(req),
        state: "ready",
        baseoid: Base,
        method: "squash",
        uptodate: "notrequired",
        rows: [
            {
                number: 1,
                headoid: head(1),
                state: "simulated",
                impacts: [
                    { number: 2, headoid: head(2), paths: ["src/a.ts"], pathcount: 1 },
                    { number: 4, headoid: head(4), paths: ["a", "b", "c", "d"], pathcount: 5 },
                ],
            },
            {
                number: 2,
                headoid: head(2),
                state: "simulated",
                impacts: [{ number: 1, headoid: head(1), paths: ["src/a.ts"], pathcount: 1 }],
            },
            { number: 3, headoid: head(3), state: "simulated", impacts: [] },
            { number: 4, headoid: head(4), state: "simulated", impacts: [] },
        ],
        ...extra,
    };
}

const Prs = [pr(1), pr(2), pr(3), pr(4, { draft: true })];

describe("conflict forecast model", () => {
    it("asks for the ready PRs and the drafts on the base most of them report", () => {
        const prs = [pr(1), pr(2, { baseoid: "c".repeat(40) }), pr(3), pr(4, { draft: true, headoid: "" })];
        expect(forecastBaseOid(prs)).toBe(Base);
        const req = forecastRequestOf(answer(prs.slice(0, 3), prs.slice(3)), {
            ready: prs.slice(0, 3),
            drafts: prs.slice(3),
        });
        expect(req).toMatchObject({ dir: "/p", repo: "a/b", base: "develop", baseoid: Base });
        expect(req.prs.map((p) => [p.number, p.ready ?? false])).toEqual([
            [1, true],
            [2, true],
            [3, true],
        ]);
    });

    it("asks nothing without a repository, a ready PR or a second PR", () => {
        const one = [pr(1)];
        expect(forecastRequestOf(answer(one), { ready: one, drafts: [] })).toBeNull();
        expect(forecastRequestOf({ ...answer(Prs), state: "nogh" }, { ready: Prs, drafts: [] })).toBeNull();
        const drafts = [pr(1, { draft: true }), pr(2, { draft: true })];
        expect(forecastRequestOf(answer([], drafts), { ready: [], drafts })).toBeNull();
    });

    it("keys a request like wavesrv's ForecastKey, whatever the order", () => {
        const req = forecastRequestOf(answer([pr(2), pr(1)]), { ready: [pr(2), pr(1)], drafts: [] });
        expect(forecastKey(req)).toBe(`develop@${Base}|1@${head(1)}r,2@${head(2)}r`);
    });

    it("AC-1: a PR whose merge leaves every other PR mergeable has no mark", () => {
        const forecast = forecastOf(Prs);
        expect(impactsOf(forecast, pr(3), Prs)).toEqual([]);
        expect(forecastMark(impactsOf(forecast, pr(3), Prs))).toBeNull();
    });

    it("AC-2: a PR that would put two others in conflict shows 2, with their files", () => {
        const forecast = forecastOf(Prs);
        const mark = forecastMark(impactsOf(forecast, pr(1), Prs));
        expect(mark.label).toBe("2");
        expect(mark.title).toContain("2 other pull requests in conflict");
        expect(mark.title).toContain("#2: src/a.ts");
        expect(mark.title).toContain("#4: a, b, c, d and 1 more");
        expect(mark.aria).toBe("merging it would put 2 pull requests in conflict");
    });

    it("drops what no longer holds: a pushed head, a moved base", () => {
        const pushed = [pr(1), pr(2, { headoid: "e".repeat(40) }), pr(3), pr(4, { draft: true })];
        const forecast = forecastOf(Prs);
        expect(impactsOf(forecast, pr(1), pushed).map((i) => i.number)).toEqual([4]);
        expect(impactsOf(forecast, pushed[1], pushed)).toEqual([]);
        const moved = Prs.map((p) => ({ ...p, baseoid: "f".repeat(40) }));
        expect(impactsOf(forecast, moved[0], moved)).toEqual([]);
        expect(impactsOf({ ...forecast, state: "failed" }, pr(1), Prs)).toEqual([]);
    });

    it("names the PRs whose merge would put one in conflict", () => {
        const forecast = forecastOf(Prs);
        expect(impactedBy(forecast, pr(1), Prs)).toEqual([{ number: 2, paths: ["src/a.ts"], pathcount: 1 }]);
        expect(impactedNote(impactedBy(forecast, pr(4), Prs))).toBe("Conflicts once #1 is merged: a, b, c and 2 more");
        expect(impactedNote([])).toBe("");
    });

    it("words the paths with what was left out", () => {
        expect(pathsText(["a"], 1)).toBe("a");
        expect(pathsText(["a", "b", "c", "d"], 40)).toBe("a, b, c and 37 more");
    });

    it("links the active row to the rows it would put in conflict", () => {
        const forecast = forecastOf(Prs);
        const ready = Prs.slice(0, 3);
        const shown = listForecast(forecast, ready, Prs, 1);
        expect(shown.targets).toEqual([2, 4]);
        expect(shown.rows[1].mark.count).toBe(2);
        expect(shown.rows[2]).toMatchObject({ linked: true, note: "Conflicts once #1 is merged: src/a.ts" });
        expect(shown.rows[3]).toMatchObject({ linked: false, note: "", mark: null });
        expect(shown.rows[4].mark).toBeNull();
        expect(listForecast(forecast, ready, Prs, null).targets).toEqual([]);
    });

    it("states the forecast: computing, stale, failed, ready", () => {
        const req = forecastRequestOf(answer(Prs.slice(0, 3), Prs.slice(3)), {
            ready: Prs.slice(0, 3),
            drafts: Prs.slice(3),
        });
        expect(forecastStatus(null, req).kind).toBe("computing");
        expect(forecastStatus(null, null).kind).toBe("none");
        const forecast = forecastOf(Prs);
        expect(forecastStatus(forecast, req)).toMatchObject({ kind: "ready", text: "Conflict forecast · squash" });
        expect(forecastStatus({ ...forecast, stale: true, running: true }, req).kind).toBe("stale");
        expect(forecastStatus({ ...forecast, key: "other" }, req).kind).toBe("stale");
        const failed = forecastStatus({ ...forecast, state: "failed", error: "toomany" }, req);
        expect(failed).toMatchObject({ kind: "failed", text: "Conflict forecast unavailable" });
        expect(failed.title).toContain("more than 40");
        const rebase = forecastStatus({ ...forecast, method: "rebase", approximate: true, uptodate: "required" }, req);
        expect(rebase.title).toContain("A rebase is simulated as one merge");
        expect(rebase.title).toContain("requires branches to be up to date");
    });
});
