// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { I18nModel } from "../i18n/i18n";
import { BatchStopLine } from "./reviews-batch";
import {
    BatchItem,
    BatchReason,
    batchRetryRequest,
    batchRowMark,
    BatchRun,
    batchStopHelp,
} from "./reviews-batch-model";
import type { ReviewCheck, ReviewPr } from "./reviews-model";
import {
    batchBannerTurn,
    batchStoppedOn,
    CardContext,
    cardStates,
    sectionsByTurn,
    withTurnShown,
} from "./reviews-sections-model";
import type { UpcomingAnswer } from "./reviews-upcoming-model";

const Reviewed = "a".repeat(40);
const Validated = "b".repeat(40);
const Start = Date.parse("2026-11-09T10:00:00Z");

function item(extra: Partial<BatchItem> = {}): BatchItem {
    return {
        number: 1168,
        headref: "fix/1168-x",
        headoid: Reviewed,
        valid: Validated,
        title: "PR 1168",
        method: "rebase",
        source: "validate",
        state: "stopped",
        reason: "citimeout",
        ...extra,
    };
}

function run(items: BatchItem[]): BatchRun {
    return {
        id: "r1",
        dir: "/p",
        repo: "a/b",
        base: "develop",
        state: "done",
        current: -1,
        items,
        ciruns: 1,
        startedat: 1,
    };
}

const check = (name: string, state: ReviewCheck["state"]): ReviewCheck => ({ name, state });

function pr(checks: ReviewCheck[], headoid = Validated): ReviewPr {
    const count = (s: string) => checks.filter((c) => c.state === s).length;
    const failure = count("failure");
    const pending = count("pending");
    return {
        number: 1168,
        title: "PR 1168",
        url: "https://github.com/a/b/pull/1168",
        branch: "fix/1168-x",
        base: "develop",
        headoid,
        createdat: "",
        updatedat: "",
        merge: pending > 0 ? "running" : "clean",
        ci: {
            state: failure > 0 ? "failure" : pending > 0 ? "pending" : "success",
            success: count("success"),
            failure,
            pending,
            checks,
        },
        report: { state: "present" },
        unpublished: 0,
    };
}

const Green = pr([check("build", "success"), check("local-tests", "success")]);
const Running = pr([check("build", "success"), check("local-tests", "pending")]);

function sections(p: ReviewPr, r: BatchRun) {
    const upcoming = { dir: "/p", branches: [], agents: [], drafts: [], at: Start } as unknown as UpcomingAnswer;
    const ctx: CardContext = {
        upcoming,
        states: { states: {} } as unknown as AgentStatesData,
        now: Start,
        boardText: (s) => s,
        batchRun: () => r,
    };
    const cards = cardStates([p], {}, (n) => `/p#${n}`, ctx);
    return { card: cards[p.number], turns: sectionsByTurn([p], cards, "state").map((s) => s.turn) };
}

describe("a stopped PR whose stop reason cleared (#2141)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("AC-1: checks green on the validated commit offer Try again, bound to that commit", () => {
        for (const stopped of [item(), item({ state: "failed", reason: "failing", names: ["local-tests"] })]) {
            const help = batchStopHelp(stopped, "develop", Green);
            expect(help, stopped.reason).toMatchObject({ action: "retry", cleared: "passed", outage: false });
            expect(help.sentence).toBe(
                "Its checks have now passed on the commit you validated: nothing was merged yet."
            );
            const req = batchRetryRequest(run([stopped]), stopped, "ws");
            expect(req.prs[0].headoid).toBe(Validated);
        }
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(batchStopHelp(item(), "develop", Green).sentence).toBe(
            "Ses checks sont maintenant passés sur le commit que vous avez validé, rien n'a encore été fusionné."
        );
    });

    it("AC-1: the card stays the developer's, with Try again drawn on its stop line", () => {
        const r = run([item()]);
        const { card, turns } = sections(Green, r);
        expect([card.kind, turns]).toEqual(["queue-stopped", ["yours"]]);
        const html = renderToStaticMarkup(
            <BatchStopLine
                mark={batchRowMark(r, 1168, Green)}
                number={1168}
                base="develop"
                busy={false}
                onAction={() => {}}
                onOpenLink={() => {}}
            />
        );
        expect(html).toContain('data-action="retry"');
        expect(html).toContain("Its checks have now passed");
        expect(html).not.toContain("did not finish in time");
    });

    it("AC-2: checks still running say so, offer See the CI, and do not count as needing the developer", () => {
        const r = run([item()]);
        const help = batchStopHelp(item(), "develop", Running);
        expect(help).toMatchObject({ action: "ci", cleared: "running" });
        expect(help.sentence).toBe("The merge queue stopped on it, and its checks are still running.");
        expect(batchStoppedOn(r, Running)).toBe(false);
        const { card, turns } = sections(Running, r);
        expect(card.kind).toBe("ci-running");
        expect(turns).not.toContain("yours");
        expect(batchRowMark(r, 1168, Running).stop.action).toBe("ci");
    });

    it("keeps the stop as it was on another commit, on a failure, or without the list's PR", () => {
        expect(batchStopHelp(item(), "develop", pr([check("build", "success")], "c".repeat(40)))).toMatchObject({
            action: "ci",
            sentence: "Its checks did not finish in time",
        });
        expect(batchStopHelp(item(), "develop", pr([check("build", "failure")])).action).toBe("ci");
        expect(batchStopHelp(item(), "develop").cleared).toBeUndefined();
        expect(batchStopHelp(item({ reason: "blocked" }), "develop", Green).action).toBe("github");
        expect(batchStoppedOn(run([item()]), pr([check("build", "failure")]))).toBe(true);
    });

    it("AC-4: no stop reason leaves the card without an action", () => {
        const reasons: BatchReason[] = [
            "failing",
            "ambiguous",
            "conflict",
            "agentexited",
            "agenttimeout",
            "noagent",
            "agentmissing",
            "agentstart",
            "blocked",
            "warnings",
            "citimeout",
            "unknown",
            "mergefailed",
            "read",
            "unavailable",
            "headmoved",
            "draft",
            "mergedaway",
            "closed",
            "notreached",
            "cancelled",
            "interrupted",
            "pushed",
            "withdrawn",
            "method",
        ];
        for (const reason of reasons) {
            for (const state of ["stopped", "failed"] as const) {
                for (const p of [undefined, Green, Running]) {
                    const help = batchStopHelp(item({ reason, state }), "develop", p);
                    expect(help.action, `${reason} ${state}`).not.toBeNull();
                    expect(help.sentence, `${reason} ${state}`).not.toBe("");
                }
            }
        }
        expect(batchStopHelp(item({ reason: undefined }), "develop").action).toBe("github");
    });
});

describe("the running merge queue's banner (#2141)", () => {
    it("heads the list in both sorts while the queue runs, and goes back to In progress once it ended", () => {
        const waitingCi = item({ state: "waitingchecks", reason: undefined });
        const running = { ...run([waitingCi]), state: "running", current: 0 } as BatchRun;
        expect(batchBannerTurn(running)).toBeNull();
        expect(batchBannerTurn({ ...running, state: "cancelling" })).toBeNull();
        expect(batchBannerTurn(run([item()]))).toBe("waiting");
        // The banner no longer needs an empty In progress section to show in, whatever the sort.
        const { card } = sections(Green, running);
        for (const sort of ["state", "merge"] as const) {
            const shown = withTurnShown(
                sectionsByTurn([Green], { [Green.number]: card }, sort),
                "waiting",
                batchBannerTurn(running) === "waiting"
            ).map((s) => s.turn);
            expect(shown, sort).toEqual(["ready"]);
        }
    });
});
