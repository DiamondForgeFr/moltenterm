// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Analyze and resolve (#1020, FR-REV-028 AC6 to AC8): every blocker of a PR, in the brief's order, on the row's button.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { CiFailureButtons, RerunState } from "./reviews-ci-actions";
import { blockersText, investigateBlockers, prBlockers, ReviewCheck, ReviewPr } from "./reviews-model";
import { headStillFails } from "./reviews-task-model";
import type { AgentBarFacts } from "./reviews-upcoming-model";

function pr(over: Partial<ReviewPr> = {}, checks: ReviewCheck[] = []): ReviewPr {
    const failure = checks.filter((c) => c.state === "failure").length;
    return {
        number: 1083,
        title: "PR",
        url: "https://github.com/a/b/pull/1083",
        branch: "feature/1083-x",
        base: "develop",
        headoid: "abcdef1234567890",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: failure > 0 ? "failure" : "success", success: 0, failure, pending: 0, checks },
        report: { state: "present" },
        unpublished: 0,
        ...over,
    };
}

const Backend: ReviewCheck = { name: "Backend", state: "failure", workflow: "CI", runid: 389, jobid: 117 };
const LocalE2e: ReviewCheck = { name: "local-e2e", state: "failure", local: true };
const Gate: ReviewCheck = { name: "AI testing / local CI", state: "failure" };

const Idle: RerunState = { phase: "idle", text: "", ask: () => {}, confirm: () => {}, cancel: () => {} };

describe("prBlockers", () => {
    it("lists the rebase, then the remote checks, then the local CI", () => {
        const row = pr({ merge: "behind" }, [LocalE2e, Backend]);
        expect(prBlockers(row).map((b) => b.kind)).toEqual(["rebase", "remote", "local"]);
        expect(blockersText(row)).toBe("behind develop: rebase, CI failed: Backend, local CI failed: local-e2e");
    });

    it("takes a check named after the local CI as the local CI's", () => {
        expect(prBlockers(pr({}, [Gate])).map((b) => b.kind)).toEqual(["local"]);
    });

    it("adds a missing report and requested changes, and nothing on a clean PR", () => {
        const row = pr({ merge: "conflicts", report: { state: "missing" }, reviewdecision: "CHANGES_REQUESTED" });
        expect(blockersText(row)).toBe("conflicts with develop: rebase, no test report, changes requested");
        expect(prBlockers(pr())).toEqual([]);
    });

    it("sends wavesrv the row's blockers", () => {
        const sent = investigateBlockers(pr({ merge: "behind", report: { state: "missing" } }, [Backend, Gate]));
        expect(sent.merge).toBe("behind");
        expect(sent.noreport).toBe(true);
        expect(sent.localseen).toBeUndefined();
        expect(sent.checks.map((c) => [c.name, !!c.local])).toEqual([
            ["Backend", false],
            ["AI testing / local CI", true],
        ]);
        expect(investigateBlockers(pr({}, [LocalE2e])).localseen).toBe(true);
    });
});

function buttons(row: ReviewPr): string {
    return renderToStaticMarkup(
        <CiFailureButtons pr={row} rerun={Idle} investigating={false} onInvestigate={() => {}} />
    );
}

describe("the row's Analyze and resolve", () => {
    it("shows on a local CI failure alone, its title naming the blockers", () => {
        const html = buttons(pr({}, [LocalE2e]));
        expect(html).toContain('data-testid="reviews-investigate"');
        expect(html).toContain("Analyze and resolve");
        expect(html).toContain("local CI failed: local-e2e");
        expect(html).not.toContain("reviews-rerun");
    });

    it("shows without any failed check when the branch is behind", () => {
        expect(buttons(pr({ merge: "behind" }))).toContain("behind develop: rebase");
    });

    it("is absent with no blocker", () => {
        expect(buttons(pr())).toBe("");
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));
        it("words the blockers", () => {
            expect(blockersText(pr({ merge: "behind" }, [LocalE2e]))).toBe(
                "en retard sur develop : rebase, CI locale en échec : local-e2e"
            );
            expect(buttons(pr({}, [LocalE2e]))).toContain("Analyser et résoudre");
        });
    });
});

describe("headStillFails", () => {
    const done: AgentBarFacts = { kind: "panel", name: "Victoire", state: "done", since: 0 };
    it("names the checks failing on the head while the agent reads as done", () => {
        expect(headStillFails(pr({}, [Gate, LocalE2e]), done, "running")).toEqual([
            "AI testing / local CI",
            "local-e2e",
        ]);
        expect(headStillFails(pr({}, [LocalE2e]), null, "stuck")).toEqual(["local-e2e"]);
    });

    it("says nothing while the agent works or when nothing fails", () => {
        expect(headStillFails(pr({}, [LocalE2e]), { ...done, state: "working" }, "running")).toEqual([]);
        expect(headStillFails(pr(), done, "stuck")).toEqual([]);
    });
});
