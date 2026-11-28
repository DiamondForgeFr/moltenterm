// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The security fix block (FR-REV-036 AC17, #2591), each step of the validated mockup of #2511: the first-time ask, the fix
// at work, ready to merge, after the merge; and the steps a fix has besides. What each says, which button it has, and that
// the orange one is there only while the developer is needed.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import { SecurityFixBlock } from "./reviews-security-fix";
import type { SecurityBlock } from "./reviews-security-model";
import type { SecurityFix, SecurityFixState } from "./security-fix-model";
import { securityFixBlockViews } from "./security-fix-panel-model";

const Scan = "Dependency security / Scan dependencies";
const Now = Date.UTC(2026, 10, 28, 12, 0);

const Block: SecurityBlock = {
    fingerprint: "aaaa",
    check: Scan,
    origin: "declared",
    source: "report",
    advisories: [
        { id: "GO-2026-9101", ecosystem: "Go", package: "go.exemple.io/telemetrie", version: "1.4.0", fixed: "1.7.0" },
        {
            id: "GO-2026-9102",
            ecosystem: "Go",
            package: "github.com/exemple/websocket",
            version: "1.5.3",
            fixed: "1.5.4",
        },
        { id: "GHSA-xxxx-0000-yyyy", ecosystem: "npm", package: "exemple-parser", version: "2.1.0", fixed: "2.1.3" },
    ],
    trunkfailing: true,
    shared: true,
    prs: [
        { number: 4102, checks: [Scan], shared: true, reasons: ["trunk"] },
        { number: 4105, checks: [Scan], shared: true, reasons: ["trunk"] },
        { number: 4107, checks: [Scan], shared: true, reasons: ["trunk"] },
    ],
};

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/acme/shop/pull/${number}`,
        branch: `fix/${number}-avis`,
        base: "develop",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: "success", success: 3, failure: 0, pending: 0, checks: [] },
        unpublished: 0,
        ...extra,
    } as ReviewPr;
}

function fix(state: SecurityFixState, over: Partial<SecurityFix> = {}): SecurityFix {
    return {
        fingerprint: "aaaa",
        ids: Block.advisories.map((a) => a.id),
        dir: "/p",
        state,
        trunk: "develop",
        startedat: Now - 6 * 60_000,
        updatedat: Now - 1000,
        ...over,
    };
}

function answer(fixes: SecurityFix[], over: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return {
        dir: "/p",
        ready: [
            pr(4102, { securityblock: "aaaa" }),
            pr(4105, { securityblock: "aaaa" }),
            pr(4107, { securityblock: "aaaa" }),
        ],
        drafts: [],
        securityblocks: [Block],
        securityfixes: fixes,
        ...over,
    } as ReviewsAnswer;
}

function html(a: ReviewsAnswer, consent: "unasked" | "off" | "on" = "unasked", index = 0): string {
    const view = securityFixBlockViews(a, consent, Now)[index];
    return renderToStaticMarkup(
        <SecurityFixBlock
            view={view}
            answer={a}
            dir="/p"
            repo="acme/shop"
            trunk="develop"
            now={Now}
            onGoToCard={() => {}}
            onValidate={() => {}}
            onAssistedReview={() => {}}
            onLater={() => {}}
            onDismiss={() => {}}
        />
    );
}

function text(markup: string): string {
    return markup
        .replace(/<[^>]*>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function molten(markup: string): number {
    return (markup.match(/molten-btn\b(?!-)/g) ?? []).length;
}

function buttons(markup: string): string[] {
    return [...markup.matchAll(/data-testid="reviews-security-fix-([a-z]+)"/g)].map((m) => m[1]);
}

describe("the security fix block, in English", () => {
    let locale: string;
    beforeAll(() => {
        locale = I18nModel.getInstance().getLocale();
        I18nModel.getInstance().setLanguageSetting("en");
    });
    afterAll(() => I18nModel.getInstance().setLanguageSetting(locale));

    describe("step 1: the first time, asked once", () => {
        const first = html(answer([]));

        it("says the alert, the scan and the pull requests it blocks, with the advisories", () => {
            expect(first).toContain('data-step="ask"');
            const body = text(first);
            expect(body).toContain("A security alert blocks 3 pull requests");
            expect(body).toContain(
                "The dependency scan (Dependency security / Scan dependencies) fails on develop and on #4102, #4105, #4107."
            );
            expect(body).toContain("none of these pull requests brought them");
            expect(body).toContain("GO-2026-9101 go.exemple.io/telemetrie 1.4.0 → 1.7.0");
            expect(body).toContain("GHSA-xxxx-0000-yyyy npm · exemple-parser 2.1.0 → 2.1.3");
        });

        it("has the three buttons, the first is the panel's one orange action", () => {
            const body = text(first);
            expect(body).toContain("Launch the fix");
            expect(body).toContain("Launch it on its own each time");
            expect(body).toContain("Later");
            expect(buttons(first).filter((b) => ["launch", "always", "later"].includes(b))).toEqual([
                "launch",
                "always",
                "later",
            ]);
            expect(molten(first)).toBe(1);
            expect(first).toMatch(/data-testid="reviews-security-fix-launch"[^>]*data-molten="true"/);
            expect(first).toContain('data-filled="true"');
            expect(body).toContain("Asked once; you can change it in Settings › Agents.");
        });

        it("offers only the launch once he answered: nothing is asked again", () => {
            const answered = html(answer([]), "off");
            expect(buttons(answered).filter((b) => ["launch", "always", "later"].includes(b))).toEqual([
                "launch",
                "later",
            ]);
            expect(text(answered)).toContain("MoltenTerm starts the fix only when you ask.");
            expect(text(answered)).not.toContain("Asked once");
        });

        it("says a red trunk with no pull request: the scan blocks the trunk", () => {
            const trunkOnly = answer([], { securityblocks: [{ ...Block, prs: [] }], ready: [] });
            const body = text(html(trunkOnly));
            expect(body).toContain("A security alert blocks develop");
            expect(body).toContain("fails on develop. These advisories are about modules develop already uses.");
        });

        it("says the alert when the failure is shared by other pull requests rather than the trunk", () => {
            const shared = answer([], { securityblocks: [{ ...Block, trunkfailing: false }] });
            expect(text(html(shared))).toContain("fails on #4102, #4105, #4107, and none of these pull requests");
        });

        it("says a single pull request in the singular", () => {
            const one = answer([], { securityblocks: [{ ...Block, prs: [Block.prs[0]] }] });
            expect(text(html(one))).toContain("A security alert blocks 1 pull request");
        });
    });

    describe("step 2: launched on its own, at work", () => {
        const working = fix("working", {
            pr: 4110,
            ticket: 4109,
            auto: true,
            agentname: "Lucie",
            agent: "claude",
            branch: "fix/4109-avis-dependances",
            resolution: "bump",
            blockid: "block-1",
        });
        const a = answer([working], { drafts: [pr(4110, { draft: true })] });
        const markup = html(a);

        it("says the fix is in progress with its ticket, who works and what they do", () => {
            expect(markup).toContain('data-step="working"');
            const body = text(markup);
            expect(body).toContain("Security fix in progress · ticket #4109");
            expect(body).toContain("3 advisories on develop block #4102, #4105, #4107.");
            expect(body).toContain("Lucie raises the modules to the fixed versions, then runs the local CI.");
            expect(body).toContain("started on its own");
        });

        it("shows the dominoes where an agent works, and what it will unblock, each a link to its card", () => {
            expect(markup).toContain("df-domino-loader");
            expect(markup.match(/data-testid="reviews-security-fix-pr"/g)).toHaveLength(3);
            expect(text(markup)).toContain("Will unblock #4102 #4105 #4107");
        });

        it("has the agent's own line with the way to its terminal and Stop, and no orange button", () => {
            const bar = /data-testid="reviews-security-fix-agent"[\s\S]*$/.exec(markup)?.[0] ?? "";
            expect(text(bar)).toContain("Lucie");
            expect(text(bar)).toContain("fix/4109-avis-dependances");
            expect(text(bar)).toContain("working");
            expect(text(bar)).toContain("6 min");
            expect(buttons(markup)).toEqual(expect.arrayContaining(["go", "stop"]));
            expect(molten(markup)).toBe(0);
            expect(markup).not.toContain("data-filled");
        });

        it("says what the pull request's checks do while they run", () => {
            const ci = answer([working], {
                drafts: [
                    pr(4110, {
                        draft: true,
                        ci: {
                            state: "pending",
                            success: 0,
                            failure: 0,
                            pending: 2,
                            checks: [
                                { name: "a", state: "pending" },
                                { name: "b", state: "pending" },
                                { name: "c", state: "success" },
                            ],
                        },
                    }),
                ],
            });
            expect(text(html(ci))).toContain("CI 1/3");
        });

        it("says an applicability review instead of a bump when the agent found no fixed version", () => {
            const review = answer([{ ...working, resolution: "notapplicable" }]);
            expect(text(html(review))).toContain("records why these advisories do not apply here");
        });

        it("says a fix that was already on its way, followed, without Stop", () => {
            const external = answer([
                { ...working, external: true, auto: false, agentname: undefined, blockid: undefined },
            ]);
            const body = html(external);
            expect(text(body)).toContain("A fix was already on its way");
            expect(body).not.toContain("reviews-security-fix-stop");
            expect(body).not.toContain("reviews-security-fix-auto");
        });
    });

    describe("step 3: ready to merge", () => {
        const ready = fix("ready", {
            pr: 4110,
            ticket: 4109,
            prurl: "https://github.com/acme/shop/pull/4110",
            resolution: "bump",
        });
        const a = answer([ready], {
            ready: [
                ...answer([]).ready,
                pr(4110, {
                    ci: {
                        state: "success",
                        success: 14,
                        failure: 0,
                        pending: 0,
                        checks: [
                            ...Array.from({ length: 13 }, (_, i) => ({ name: `job ${i}`, state: "success" as const })),
                            { name: "AI testing / Local CI", state: "success" as const },
                        ],
                    },
                    report: { state: "present" },
                }),
            ],
        });
        const markup = html(a);

        it("says which merge unblocks which, and what the pull request holds", () => {
            expect(markup).toContain('data-step="ready"');
            const body = text(markup);
            expect(body).toContain("Merging #4110 unblocks #4102, #4105, #4107");
            expect(body).toContain(
                "Raises 3 dependencies to their fixed versions. CI 14/14, local CI passed, test report."
            );
            expect(body).toContain("GO-2026-9101 go.exemple.io/telemetrie 1.4.0 → 1.7.0");
            expect(body).toContain("Raised");
        });

        it("has the molten Merge button, an assisted review and GitHub", () => {
            expect(text(markup)).toContain("Merge #4110…");
            expect(buttons(markup)).toEqual(expect.arrayContaining(["merge", "review", "github"]));
            expect(molten(markup)).toBe(1);
            expect(markup).toMatch(/data-testid="reviews-security-fix-merge"[^>]*data-molten="true"/);
            expect(text(markup)).toContain("Once it is merged, MoltenTerm brings #4102, #4105, #4107 onto develop");
        });

        it("says a review with its evidence instead of the versions when nothing applies", () => {
            const body = text(html(answer([{ ...ready, resolution: "notapplicable" }], { ready: a.ready })));
            expect(body).toContain("Records why these advisories do not apply here");
            expect(body).toContain("not applicable here");
        });

        it("has no Merge button when the list does not hold the pull request", () => {
            expect(html(answer([ready]))).not.toContain("reviews-security-fix-merge");
        });
    });

    describe("step 4: after the merge", () => {
        const merged = fix("merged", { pr: 4110, mergedat: Now - 60_000, unblocks: [4102, 4105, 4107] });
        const a = answer([merged], {
            securityblocks: [],
            ready: [
                pr(4102, { ci: { state: "pending", success: 9, failure: 0, pending: 5, checks: [] } }),
                pr(4105, { ci: { state: "pending", success: 9, failure: 0, pending: 5, checks: [] } }),
                pr(4107),
            ],
        });
        const markup = html(a);

        it("says the merge and how many pull requests it unblocked, dismissable", () => {
            expect(markup).toContain('data-step="merged"');
            expect(text(markup)).toContain("#4110 merged · 3 pull requests unblocked");
            expect(text(markup)).toContain(
                "The advisories are fixed on develop: the pull requests they blocked resume."
            );
            expect(buttons(markup)).toContain("hide");
            expect(molten(markup)).toBe(0);
        });

        it("has a row per pull request, with a mark that says it and its checks", () => {
            expect(markup.match(/data-testid="reviews-security-fix-after-row"/g)).toHaveLength(3);
            const rows = markup.split('data-testid="reviews-security-fix-after-row"').slice(1).map(text);
            expect(rows[0]).toContain("#4102 checks running");
            expect(rows[2]).toContain("#4107 checks passed");
            expect(markup).toContain('aria-label="Running"');
            expect(markup).toContain('aria-label="Ready"');
        });

        it("has no advisories table: the work is done", () => {
            expect(markup).not.toContain("reviews-security-fix-advisories");
        });

        it("words what the unblock step recorded when it did, the pull request an agent works on handed to it", () => {
            // the data hook of #2590: until it records, the rows say what the list says
            expect(text(markup)).not.toContain("is handed to");
        });
    });

    describe("the steps a fix has besides", () => {
        it("waits for a place and says why, with Stop", () => {
            const markup = html(answer([fix("waiting", { reason: "machinebusy", ticket: 4109 })]));
            expect(markup).toContain('data-step="waiting"');
            expect(text(markup)).toContain("The security fix waits for a place · ticket #4109");
            expect(text(markup)).toContain("This computer is busy");
            expect(buttons(markup)).toContain("stop");
            expect(molten(markup)).toBe(0);
        });

        it("needs the developer: the agent's own line, the way to its terminal as the orange button", () => {
            const markup = html(
                answer([
                    fix("needsyou", {
                        reason: "outcome",
                        outcome: "no fixed version exists",
                        agentname: "Lucie",
                        ticket: 4109,
                        blockid: "block-1",
                    }),
                ])
            );
            expect(markup).toContain('data-step="needsyou"');
            expect(text(markup)).toContain("Lucie needs you on the security fix #4109");
            expect(text(markup)).toContain("no fixed version exists");
            expect(markup).toMatch(/data-testid="reviews-security-fix-go"[^>]*data-molten="true"/);
            expect(molten(markup)).toBe(1);
        });

        it("was stopped: says it is not started again on its own, and can be launched again, calmly", () => {
            const markup = html(answer([fix("stopped")]));
            expect(text(markup)).toContain("Security fix stopped");
            expect(text(markup)).toContain(
                "You stopped it: it is not started again on its own. 3 advisories still block"
            );
            expect(text(markup)).toContain("Relaunch the fix");
            expect(molten(markup)).toBe(0);
        });

        it("failed: says why, and the relaunch is the orange button", () => {
            const markup = html(answer([fix("failed", { reason: "noagent" })]));
            expect(text(markup)).toContain("The security fix did not go through");
            expect(text(markup)).toContain("No supported coding agent is installed on this computer");
            expect(molten(markup)).toBe(1);
        });
    });

    it("draws the advisories without a column of versions it does not know", () => {
        const bare = answer([], { securityblocks: [{ ...Block, advisories: [{ id: "GO-2026-9101" }] }] });
        expect(text(html(bare))).toContain("GO-2026-9101 —");
    });

    it("names no operating system, and uses no emoji", () => {
        for (const markup of [
            html(answer([])),
            html(answer([fix("working", { pr: 4110 })])),
            html(answer([fix("ready", { pr: 4110 })])),
        ]) {
            expect(markup).not.toMatch(/\b(Mac|macOS|Finder|Windows|Linux|Explorer)\b/);
            expect(markup).not.toMatch(/\p{Extended_Pictographic}/u);
        }
    });
});

describe("the security fix block, in French", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("words the first-time ask as the mockup does", () => {
        const body = text(html(answer([])));
        expect(body).toContain("Une alerte de sécurité bloque 3 pull requests");
        expect(body).toContain(
            "L'analyse des dépendances (Dependency security / Scan dependencies) échoue sur develop et sur #4102, #4105, #4107."
        );
        expect(body).toContain("Lancer le correctif");
        expect(body).toContain("Le lancer seul à chaque fois");
        expect(body).toContain("Plus tard");
    });

    it("words the fix at work, ready and merged", () => {
        const working = html(
            answer([fix("working", { pr: 4110, ticket: 4109, auto: true, agentname: "Lucie", resolution: "bump" })])
        );
        expect(text(working)).toContain("Correctif de sécurité en cours · ticket #4109");
        expect(text(working)).toContain("3 avis sur develop bloquent #4102, #4105, #4107.");
        expect(text(working)).toContain("Lucie monte les modules aux versions corrigées, puis lance la CI locale.");
        expect(text(working)).toContain("Débloquera #4102 #4105 #4107");
        expect(text(working)).toContain("lancé tout seul");
        const ready = html(answer([fix("ready", { pr: 4110 })], { ready: [...answer([]).ready, pr(4110)] }));
        expect(text(ready)).toContain("Fusionner #4110 débloque #4102, #4105, #4107");
        expect(text(ready)).toContain("Fusionner #4110…");
        const merged = html(
            answer([fix("merged", { pr: 4110, mergedat: Now, unblocks: [4102, 4105, 4107] })], { securityblocks: [] })
        );
        expect(text(merged)).toContain("#4110 fusionnée · 3 pull requests débloquées");
    });
});
