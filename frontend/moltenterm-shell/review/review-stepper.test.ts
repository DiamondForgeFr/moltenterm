// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { translate } from "../i18n/i18n-core";
import type { ReviewCleanupResult, ReviewCleanupStepResult, ReviewWorktreeLoss } from "./review-cleanup";
import type { ReviewMergeCheck, ReviewMergePlan, ReviewMergeRecord } from "./review-client";
import {
    buildValidateSteps,
    checkDetail,
    keptButtonLabel,
    lossButtonLabel,
    lossLines,
    mergeOutcomeText,
    Translate,
    ValidateStep,
} from "./review-stepper";

const en: Translate = (key, vars) => translate("en", key, vars);
const fr: Translate = (key, vars) => translate("fr", key, vars);

const okChecks: ReviewMergeCheck[] = [
    { id: "open", state: "ok" },
    { id: "ci", state: "ok", code: "passed", count: 3, local: 1 },
    { id: "conflict", state: "ok", base: "develop" },
    { id: "blocked", state: "ok" },
    { id: "comments", state: "ok" },
    { id: "restart", state: "ok" },
];

function plan(over: Partial<ReviewMergePlan> = {}): ReviewMergePlan {
    return {
        id: "p1",
        repo: "o/n",
        number: 670,
        dir: "/p",
        ticket: 672,
        headref: "feature/672-x",
        baseref: "develop",
        headoid: "a".repeat(40),
        prstate: "OPEN",
        checks: okChecks,
        steps: [{ id: "merge" }],
        cleanup: [
            { id: "pr", state: "planned" },
            { id: "ticket-close", state: "planned", ticket: 672 },
            { id: "ticket-done", state: "planned", ticket: 672 },
            { id: "review-worktree", state: "planned", code: "noreviewtree" },
            { id: "agent-worktree", state: "planned", code: "willremove", path: "/w/app-672", branch: "feature/672-x" },
            { id: "local-branch", state: "planned", branch: "feature/672-x", base: "develop" },
            { id: "remote-branch", state: "planned", branch: "feature/672-x", base: "develop" },
            { id: "other-prs", state: "planned", base: "develop" },
        ],
        canmerge: true,
        warnings: [],
        createdat: 1,
        ...over,
    };
}

const merged: ReviewMergeRecord = {
    planid: "p1",
    method: "rebase",
    planhead: "a".repeat(40),
    head: "a".repeat(40),
    state: "merged",
    code: "merged",
    startedat: 1,
    endedat: 2,
};

function cleanup(agent: ReviewCleanupStepResult, local: ReviewCleanupStepResult): ReviewCleanupResult {
    return {
        repo: "o/n",
        number: 670,
        branch: "feature/672-x",
        base: "develop",
        startedat: 3,
        endedat: 4,
        steps: [
            { id: "pr", state: "done", code: "merged", base: "develop" },
            { id: "ticket-close", state: "done", code: "closed", ticket: 672 },
            { id: "ticket-done", state: "done", code: "moveddone", ticket: 672 },
            { id: "review-worktree", state: "skipped", code: "noreviewtree" },
            agent,
            local,
            { id: "remote-branch", state: "done", code: "deletedbymerge", branch: "feature/672-x" },
            {
                id: "other-prs",
                state: "done",
                code: "otherprs",
                base: "develop",
                unaffected: 1,
                conflicting: 1,
                prs: [
                    { number: 671, branch: "fix/662-x", state: "skipped", flag: "needs-agent", url: "https://x/671" },
                    { number: 669, branch: "feature/669-y", state: "done" },
                ],
            },
        ],
    };
}

function texts(steps: ValidateStep[]): string[] {
    return steps.flatMap((s) => [s.title, ...s.lines, ...s.rows.flatMap((r) => [r.label, ...r.lines])]);
}

function step(steps: ValidateStep[], id: string): ValidateStep {
    return steps.find((s) => s.id === id);
}

const generatedOnly: ReviewWorktreeLoss = {
    changes: [],
    changecount: 0,
    commits: [],
    commitcount: 0,
    ignored: ["node_modules/", "dist/", ".task/", "test-results.xml"],
    ignoredcount: 4,
};

describe("Validate's stepper", () => {
    it("shows the plan in execution order, each step with its consequence", () => {
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: null,
            cleanup: null,
            headref: "x",
            baseref: "develop",
        });
        expect(steps.map((s) => s.id)).toEqual(["checks", "merge", "ticket", "cleanup", "others"]);
        const checks = step(steps, "checks");
        expect(checks.state).toBe("done");
        expect(checks.collapsed).toBe(true);
        expect(checks.lines).toEqual(["All 6 checks pass."]);
        expect(step(steps, "merge").lines).toContain(
            "feature/672-x will be rebased and merged into develop, then deleted on GitHub."
        );
        expect(step(steps, "ticket").rows.map((r) => r.lines[0])).toEqual([
            "#672 will be closed.",
            "#672 will move to Done.",
        ]);
        const clean = step(steps, "cleanup");
        expect(clean.lines[0]).toMatch(/^The worktrees and branches will be removed/);
        expect(clean.rows.map((r) => [r.id, r.state, r.lines[0]])).toEqual([
            ["review-worktree", "skipped", "Nothing to do: this review used the agent's worktree."],
            ["agent-worktree", "todo", "/w/app-672 will be removed."],
            ["local-branch", "todo", "feature/672-x will be deleted."],
            ["remote-branch", "todo", "origin/feature/672-x will be deleted last, once the worktree and the local branch are gone."],
        ]);
        expect(step(steps, "others").lines[0]).toMatch(/are left as they are; those this merge puts in conflict/);
    });

    it("expands the checks on a problem and says why Merge waits", () => {
        const checks: ReviewMergeCheck[] = [
            ...okChecks.slice(0, 1),
            { id: "ci", state: "fail", code: "failing", count: 1, names: ["lint"] },
            { id: "comments", state: "warn", code: "unpublished", count: 2 },
        ];
        const steps = buildValidateSteps(en, {
            plan: plan({ checks }),
            record: null,
            cleanup: null,
            headref: "x",
            baseref: "develop",
        });
        const c = step(steps, "checks");
        expect(c.state).toBe("failed");
        expect(c.collapsed).toBeFalsy();
        expect(c.rows.map((r) => r.state)).toEqual(["done", "failed", "needs"]);
        expect(c.rows[1].lines).toEqual([
            "1 failing: lint. GitHub requires them and refuses the merge while they fail.",
        ]);
        expect(c.rows[2].lines[0]).toMatch(/^2 comments written here/);
    });

    it("reads a merge blocked while the CI runs as waiting, not failed (#925)", () => {
        const checks: ReviewMergeCheck[] = [
            okChecks[0],
            { id: "ci", state: "pending", code: "running", count: 9, names: ["build"] },
            { id: "conflict", state: "ok", base: "develop" },
            { id: "blocked", state: "pending", code: "waitsci" },
        ];
        for (const [t, line] of [
            [en, "2 checks are still running: nothing needs you yet."],
            [fr, "2 vérifications tournent encore : rien ne vous attend pour l'instant."],
        ] as const) {
            const c = step(
                buildValidateSteps(t, {
                    plan: plan({ checks }),
                    record: null,
                    cleanup: null,
                    headref: "x",
                    baseref: "d",
                }),
                "checks"
            );
            expect(c.state).toBe("running");
            expect(c.rows.map((r) => r.state)).toEqual(["done", "running", "done", "running"]);
            expect(c.lines).toEqual([line]);
        }
        const failing: ReviewMergeCheck[] = [
            okChecks[0],
            { id: "ci", state: "fail", code: "failing", count: 1, names: ["lint"] },
            { id: "blocked", state: "pending", code: "waitsci" },
        ];
        const c = step(
            buildValidateSteps(en, {
                plan: plan({ checks: failing }),
                record: null,
                cleanup: null,
                headref: "x",
                baseref: "d",
            }),
            "checks"
        );
        expect(c.state).toBe("failed");
        expect(c.lines).toEqual(["1 check needs your attention."]);
    });

    it("removes a worktree holding only generated files and says nothing was lost", () => {
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: merged,
            cleanup: cleanup(
                { id: "agent-worktree", state: "done", code: "removed", path: "/w/app-672", loss: generatedOnly },
                { id: "local-branch", state: "done", code: "deleted", branch: "feature/672-x" }
            ),
            headref: "x",
            baseref: "develop",
        });
        expect(step(steps, "merge").lines[0]).toBe("Rebased and merged into develop at aaaaaaa.");
        const clean = step(steps, "cleanup");
        expect(clean.state).toBe("done");
        const agent = clean.rows.find((r) => r.id === "agent-worktree");
        expect(agent.lines[0]).toBe("/w/app-672 removed.");
        expect(agent.lines[1]).toMatch(
            /^4 git-ignored items went with it \(node_modules\/, dist\/, .task\/ and 1 more\): nothing to lose/
        );
        expect(step(steps, "ticket").state).toBe("done");
        const others = step(steps, "others");
        expect(others.state).toBe("needs");
        expect(others.rows).toHaveLength(1);
        expect(others.rows[0]).toMatchObject({ label: "#671 fix/662-x", url: "https://x/671", state: "needs" });
        expect(others.rows[0].startAgent?.number).toBe(671);
        expect(others.rows[0].lines[0]).toBe(
            "Conflicts with develop, and no agent works on its branch → start an agent."
        );
        expect(others.lines).toEqual(["1 unaffected · 1 now conflicts with develop"]);
    });

    it("names what removing a kept worktree would lose, and the button says it", () => {
        const loss: ReviewWorktreeLoss = {
            changes: ["foo.ts", "bar.ts"],
            changecount: 2,
            commits: [],
            commitcount: 0,
            ignored: [],
            ignoredcount: 0,
        };
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: merged,
            cleanup: cleanup(
                {
                    id: "agent-worktree",
                    state: "skipped",
                    code: "kept",
                    path: "/w/app-672",
                    branch: "feature/672-x",
                    loss,
                },
                { id: "local-branch", state: "skipped", code: "inkepttree", branch: "feature/672-x" }
            ),
            headref: "x",
            baseref: "develop",
        });
        const clean = step(steps, "cleanup");
        expect(clean.state).toBe("needs");
        const agent = clean.rows.find((r) => r.id === "agent-worktree");
        expect(agent.state).toBe("needs");
        expect(agent.lines).toEqual([
            "Kept, with feature/672-x: removing /w/app-672 would lose work.",
            "2 uncommitted files would be lost: foo.ts, bar.ts",
        ]);
        expect(lossButtonLabel(en, loss)).toBe("Remove and lose 2 files");
        expect(lossButtonLabel(fr, loss)).toBe("Supprimer et perdre 2 fichiers");
        const late = {
            ...loss,
            changes: [],
            changecount: 0,
            commits: [{ sha: "b".repeat(40), subject: "late" }],
            commitcount: 1,
        };
        expect(lossLines(en, late)).toEqual([
            "1 commit is not in the merged pull request and would be lost: bbbbbbb late",
        ]);
        expect(lossButtonLabel(en, late)).toBe("Remove and lose 1 commit");
        expect(lossButtonLabel(en, { ...loss, commits: late.commits, commitcount: 1 })).toBe(
            "Remove and lose 2 files and 1 commit"
        );
        expect(lossButtonLabel(en, { ...late, commits: [], commitcount: -1 })).toBe(
            "Remove the worktree and its branch"
        );
        for (const label of [lossButtonLabel(en, loss), lossButtonLabel(en, late)]) {
            expect(label.toLowerCase()).not.toContain("anyway");
        }
    });

    it("keeps a worktree a panel still works in, and names the panel", () => {
        const panels = [{ blockid: "b1", tab: "Agent 7", agent: "working" }];
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: merged,
            cleanup: cleanup(
                {
                    id: "agent-worktree",
                    state: "skipped",
                    code: "inuse",
                    path: "/w/app-672",
                    branch: "feature/672-x",
                    loss: generatedOnly,
                    panels,
                },
                { id: "local-branch", state: "skipped", code: "inkepttree", branch: "feature/672-x" }
            ),
            headref: "x",
            baseref: "develop",
        });
        const agent = step(steps, "cleanup").rows.find((r) => r.id === "agent-worktree");
        expect(agent.state).toBe("needs");
        expect(agent.lines).toEqual([
            "Kept, with feature/672-x: a panel still works in /w/app-672.",
            "An agent is still running in this folder: Agent 7",
        ]);
        const inuse = { id: "agent-worktree", state: "skipped", code: "inuse", loss: generatedOnly, panels } as const;
        expect(keptButtonLabel(en, inuse)).toBe("Close the panel and remove");
        expect(keptButtonLabel(fr, inuse)).toBe("Fermer le panneau et supprimer");
        const two = { ...inuse, panels: [...panels, { blockid: "b2", tab: "Shell" }] };
        expect(keptButtonLabel(en, two)).toBe("Close the panels and remove");
        const dirty = { ...inuse, code: "kept", loss: { ...generatedOnly, changes: ["a.ts"], changecount: 1 } };
        expect(keptButtonLabel(en, dirty)).toBe("Close the panel, remove and lose 1 file");
    });

    it("skips the steps after a merge that did not happen, and says why", () => {
        const refused: ReviewMergeRecord = {
            ...merged,
            state: "refused",
            refused: "headmoved",
            code: "headmoved",
            movedfrom: "a".repeat(40),
            movedto: "c".repeat(40),
        };
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: refused,
            cleanup: null,
            headref: "x",
            baseref: "develop",
        });
        expect(step(steps, "merge").state).toBe("failed");
        expect(step(steps, "merge").lines[0]).toMatch(/head ccccccc, the plan was made for aaaaaaa/);
        for (const id of ["ticket", "cleanup", "others"]) {
            expect(step(steps, id)).toMatchObject({ state: "skipped", lines: ["Not run: nothing was merged."] });
        }
    });

    it("runs the cleanup steps while the cleanup runs", () => {
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: { ...merged, cleanuprunning: true },
            cleanup: null,
            headref: "x",
            baseref: "develop",
        });
        expect(step(steps, "cleanup").state).toBe("running");
        expect(step(steps, "ticket").state).toBe("running");
    });

    it("reads in French with no English from wavesrv", () => {
        const steps = buildValidateSteps(fr, {
            plan: plan(),
            record: merged,
            cleanup: cleanup(
                { id: "agent-worktree", state: "done", code: "removed", path: "/w/app-672", loss: generatedOnly },
                { id: "local-branch", state: "done", code: "deleted", branch: "feature/672-x" }
            ),
            headref: "x",
            baseref: "develop",
        });
        expect(step(steps, "merge").lines[0]).toBe("Rebasée et fusionnée dans develop à aaaaaaa.");
        for (const text of texts(steps)) {
            expect(text).not.toMatch(/^review\./);
            expect(text).not.toMatch(/\b(will be|removed|deleted|merged into|is merged|needs a rebase)\b/);
        }
    });

    it("shows a folder a removal left as a warning, never a failure (#716)", () => {
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: merged,
            cleanup: cleanup(
                {
                    id: "agent-worktree",
                    state: "done",
                    code: "leftover",
                    path: "/w/app-716",
                    error: "unlinkat /w/app-716: directory not empty",
                },
                { id: "local-branch", state: "done", code: "deleted", branch: "feature/672-x" }
            ),
            headref: "x",
            baseref: "develop",
        });
        const cleanupStep = step(steps, "cleanup");
        const agent = cleanupStep.rows.find((r) => r.id === "agent-worktree");
        expect(agent.state).toBe("needs");
        expect(agent.error).toBeUndefined();
        expect(agent.lines.join(" ")).toContain("/w/app-716");
        expect(agent.lines.join(" ")).toContain("directory not empty");
        expect(cleanupStep.state).toBe("needs");
        expect(cleanupStep.rows.find((r) => r.id === "local-branch").state).toBe("done");
    });

    it("reads a worktree gone before the cleanup as already cleaned up (#716)", () => {
        const steps = buildValidateSteps(en, {
            plan: plan(),
            record: merged,
            cleanup: cleanup(
                { id: "agent-worktree", state: "skipped", code: "alreadygone", path: "/w/app-716" },
                { id: "local-branch", state: "done", code: "deleted", branch: "feature/672-x" }
            ),
            headref: "x",
            baseref: "develop",
        });
        const agent = step(steps, "cleanup").rows.find((r) => r.id === "agent-worktree");
        expect(agent.state).toBe("skipped");
        expect(agent.lines[0]).toBe("Already cleaned up.");
    });

    // #909: the local working branch is brought up to date after the merge, or left as it was with the reason.
    it("says what became of the local working branch", () => {
        const rows = (t: Translate, trunk: ReviewCleanupStepResult) => {
            const steps = buildValidateSteps(t, {
                plan: plan(),
                record: merged,
                cleanup: { ...cleanup(trunk, trunk), steps: [trunk] },
                headref: "x",
                baseref: "develop",
            });
            return step(steps, "cleanup").rows.map((r) => [r.label, r.state, r.lines[0]]);
        };
        const base = { id: "local-trunk", branch: "develop" } as const;
        expect(rows(en, { ...base, state: "done", code: "updated", count: 53, path: "/p" })).toEqual([
            ["Local working branch", "done", "Local develop updated: +53 commits."],
        ]);
        expect(rows(fr, { ...base, state: "done", code: "updated", count: 1 })).toEqual([
            ["Branche de travail locale", "done", "develop local mis à jour : +1 commit."],
        ]);
        expect(rows(en, { ...base, state: "skipped", code: "uptodate" })[0][1]).toBe("skipped");
        expect(rows(en, { ...base, state: "skipped", code: "localcommits", count: 3, ahead: 2 })).toEqual([
            [
                "Local working branch",
                "needs",
                "Not updated: local develop has 2 commits origin does not have. Nothing was changed.",
            ],
        ]);
        expect(
            rows(en, {
                ...base,
                state: "skipped",
                code: "changes",
                path: "/p",
                names: ["a.ts", "b.ts", "c.ts"],
                namecount: 5,
            })
        ).toEqual([
            [
                "Local working branch",
                "needs",
                "Not updated: local changes in /p would be overwritten (a.ts, b.ts, c.ts and 2 more). Nothing was changed.",
            ],
        ]);
        expect(rows(en, { ...base, state: "skipped", code: "inprogress", path: "/p" })[0][1]).toBe("needs");
        const planned = buildValidateSteps(en, {
            plan: plan({ cleanup: [{ ...base, state: "planned" }] }),
            record: null,
            cleanup: null,
            headref: "x",
            baseref: "develop",
        });
        expect(step(planned, "cleanup").rows[0].lines[0]).toBe(
            "Local develop will move up to origin/develop when nothing local is in the way (fast-forward only)."
        );
    });

    it("has a sentence for every code wavesrv sends", () => {
        const cleanupCodes: Record<string, string[]> = {
            "ticket-close": ["closed", "alreadyclosed", "noticket", "prunconfirmed"],
            "ticket-done": ["moveddone", "alreadydone", "noticket", "nosfworkflow", "prunconfirmed"],
            "review-worktree": [
                "removed",
                "noreviewtree",
                "notaworktree",
                "kept",
                "inuse",
                "prunconfirmed",
                "alreadygone",
                "leftoversremoved",
                "leftover",
            ],
            "agent-worktree": [
                "removed",
                "noagenttree",
                "refusedhome",
                "refusedrepo",
                "locked",
                "kept",
                "inuse",
                "alreadygone",
                "leftoversremoved",
                "leftover",
                "prunconfirmed",
            ],
            "local-branch": [
                "deleted",
                "nolocalbranch",
                "treefailed",
                "inkepttree",
                "inmaincheckout",
                "moved",
                "kept",
                "prunconfirmed",
            ],
            "remote-branch": ["deleted", "deletedbymerge", "pushedafter", "localfirst", "prunconfirmed"],
            "local-trunk": [
                "updated",
                "uptodate",
                "nolocaltrunk",
                "noremotetrunk",
                "localcommits",
                "changes",
                "inprogress",
                "prunconfirmed",
            ],
        };
        const planCodes: Record<string, string[]> = {
            "ticket-close": [undefined, "noticket"],
            "ticket-done": [undefined, "noticket", "nosfworkflow"],
            "review-worktree": ["willremove", "noreviewtree"],
            "agent-worktree": ["willremove", "noagenttree"],
            "local-branch": [undefined],
            "remote-branch": [undefined],
            "local-trunk": [undefined],
        };
        for (const t of [en, fr]) {
            for (const [id, codes] of Object.entries(cleanupCodes)) {
                const all: ReviewCleanupStepResult[] = [
                    ...codes.map((code) => ({ id, state: "skipped", code }) as ReviewCleanupStepResult),
                    { id, state: "failed", error: "boom" } as ReviewCleanupStepResult,
                ];
                for (const s of all) {
                    const steps = buildValidateSteps(t, {
                        plan: plan(),
                        record: merged,
                        cleanup: { ...cleanup(s, s), steps: [s] },
                        headref: "x",
                        baseref: "develop",
                    });
                    for (const text of texts(steps)) {
                        expect(text, `${id} ${s.code}`).not.toMatch(/review\./);
                    }
                }
            }
            for (const [id, codes] of Object.entries(planCodes)) {
                for (const code of codes) {
                    const p = plan({ cleanup: [{ id, state: "planned", code } as ReviewCleanupStepResult] });
                    const steps = buildValidateSteps(t, {
                        plan: p,
                        record: null,
                        cleanup: null,
                        headref: "x",
                        baseref: "develop",
                    });
                    for (const text of texts(steps)) {
                        expect(text, `${id} plan ${code}`).not.toMatch(/review\./);
                    }
                }
            }
            const checkCodes = [
                "notopen",
                "draft",
                "failing",
                "failingoptional",
                "running",
                "nocheck",
                "passed",
                "conflicting",
                "computing",
                "blocked",
                "waitsci",
                "behind",
                "unpublished",
                "inflight",
            ];
            for (const code of checkCodes) {
                expect(checkDetail(t, { id: "ci", state: "fail", code, count: 2, names: ["a"] }), code).not.toMatch(
                    /review\./
                );
            }
            const outcomes = [
                "merged",
                "reread",
                "mergedaway",
                "headmoved",
                "githubheadmoved",
                "check",
                "newwarning",
                "mergeerror",
                "updateerror",
                "stopped",
                "citimeout",
                "pollerror",
                "cifailed",
                "newred",
                "conflict",
                "basemoved",
                "rebasedblocked",
                "queueclosed",
                "queuetimeout",
                "queuestopped",
            ];
            for (const code of outcomes) {
                expect(mergeOutcomeText(t, { ...merged, state: "failed", code }, "develop"), code).not.toMatch(
                    /review\./
                );
            }
            for (const method of ["merge", "squash", "rebase"]) {
                expect(mergeOutcomeText(t, { ...merged, method }, "develop"), method).not.toMatch(/review\./);
                for (const state of ["updating", "queued"] as const) {
                    expect(mergeOutcomeText(t, { ...merged, method, state }, "develop"), state).not.toMatch(/review\./);
                }
            }
            for (const state of ["refused", "failed", "cancelled"] as const) {
                expect(mergeOutcomeText(t, { ...merged, state, code: undefined }, "develop")).not.toMatch(/review\./);
            }
            for (const id of ["open", "ci", "conflict", "blocked", "behind", "comments", "restart"]) {
                expect(t(`review.validate.check.${id}`)).not.toMatch(/review\./);
            }
            for (const s of ["todo", "running", "done", "skipped", "needs", "failed"]) {
                expect(t(`review.validate.state.${s}`)).not.toMatch(/review\./);
            }
            for (const code of ["running", "stale", "old", "blocked", "confirm", "nomerge", "method"]) {
                expect(t(`review.validate.error.${code}`)).not.toMatch(/review\./);
            }
        }
    });
});

// #673: the merge step follows the method chosen, and says what narrowed the methods.
describe("Validate's merge method", () => {
    const all = { methods: ["merge", "squash", "rebase"] as ReviewMergePlan["methods"], method: "merge" as const };
    const mergeOf = (over: Partial<ReviewMergePlan>, method?: "merge" | "squash" | "rebase", t = en) =>
        step(
            buildValidateSteps(t, {
                plan: plan(over),
                record: null,
                cleanup: null,
                headref: "x",
                baseref: "develop",
                method,
            }),
            "merge"
        );

    it("words the step and its consequence for each method", () => {
        expect(mergeOf(all).title).toBe("Create a merge commit on develop");
        expect(mergeOf(all, "squash").title).toBe("Squash into one commit on develop");
        expect(mergeOf(all, "rebase").title).toBe("Rebase onto develop");
        expect(mergeOf(all, "squash").lines[0]).toMatch(
            /one commit on develop, with the title and message this repository sets/
        );
        expect(mergeOf(all, "merge").lines[0]).toMatch(/with a merge commit that keeps its commits/);
        expect(mergeOf(all, "squash", fr).title).toBe("Squasher en un seul commit sur develop");
    });

    it("updates a branch behind its base the way the method merges", () => {
        expect(mergeOf({ ...all, behind: true }, "rebase").lines[0]).toMatch(
            /^GitHub will first rebase feature\/672-x on develop/
        );
        expect(mergeOf({ ...all, behind: true }, "squash").lines[0]).toMatch(
            /^GitHub will first merge develop into feature\/672-x/
        );
    });

    it("says what narrowed the methods", () => {
        expect(mergeOf({ methods: ["squash"], method: "squash" }).lines[0]).toBe(
            "This repository allows only: Squash."
        );
        expect(mergeOf({ methods: ["squash", "rebase"], method: "squash", methodrule: "ruleset" }).lines[0]).toBe(
            "The rules of develop allow: Squash, Rebase."
        );
        expect(mergeOf({ methods: ["squash", "rebase"], method: "squash", methodrule: "linear" }).lines[0]).toMatch(
            /requires a linear history/
        );
        const queue = mergeOf({
            methods: ["squash"],
            method: "squash",
            methodrule: "queue",
            queue: true,
            behind: true,
        });
        expect(queue.title).toBe("Merge queue of develop");
        expect(queue.lines[0]).toBe("develop merges through a merge queue, with Squash: the queue sets the method.");
        expect(queue.lines.join(" ")).not.toMatch(/will first/);
    });

    it("reports the merge in the method it used", () => {
        expect(mergeOutcomeText(en, { ...merged, method: "squash" }, "develop")).toBe(
            "Squashed into one commit on develop, from aaaaaaa."
        );
        expect(mergeOutcomeText(en, { ...merged, method: "merge", state: "updating" }, "develop")).toBe(
            "GitHub is merging develop into the branch…"
        );
        expect(mergeOutcomeText(en, { ...merged, method: "", code: "merged" }, "develop")).toBe(
            "Rebased and merged into develop at aaaaaaa."
        );
    });
});
