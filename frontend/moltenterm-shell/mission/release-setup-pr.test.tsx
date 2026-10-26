// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./release-setup-client", () => ({
    setupDraft: vi.fn(),
    setupRefine: vi.fn(),
    setupWrite: vi.fn(),
    setupCheck: vi.fn(),
    setupUpdate: vi.fn(),
    setupPrState: vi.fn(),
    setupTickets: vi.fn(),
}));

import { canOpenPr, prNamesOf, prRequestOf, SetupPrJob, SetupPrPlan } from "./release-setup-model";
import { PrFooterButtons, PrPanel, UncommittedNotice } from "./release-setup-pr";

const plan: SetupPrPlan = {
    git: true,
    ref: "origin/develop",
    commit: "abc1234",
    target: "develop",
    ongithub: true,
    ticketrequired: true,
    branch: "feature/{N}-release-pipeline",
    subject: "chore(#{N}): set up the release pipeline",
    tickettitle: "Declare the release pipeline",
    uncommitted: false,
    included: false,
    localbase: "l",
};

function job(over: Partial<SetupPrJob>): SetupPrJob {
    return {
        id: "j",
        dir: "/p",
        kind: "write",
        mode: "pr",
        steps: [
            { id: "worktree", state: "done", info: "abc1234" },
            { id: "write", state: "done", info: "2" },
            { id: "commit", state: "done", info: "def5678" },
            { id: "push", state: "running" },
            { id: "pr", state: "pending" },
        ],
        finished: false,
        ref: "origin/develop",
        target: "develop",
        ongithub: true,
        branch: "feature/7-release-pipeline",
        subject: "chore(#7): set up the release pipeline",
        ticket: 7,
        files: [".molten/project.json", ".molten/release-setup.json"],
        ...over,
    };
}

const newTicket = { ticket: 0, create: true, title: "" };

describe("the setup's pull request (#1098)", () => {
    it("names the ticket in the request only when the commit format needs one", () => {
        expect(prRequestOf(plan, { ticket: 7, create: false, title: "" }, "pr")).toEqual({ mode: "pr", ticket: 7 });
        expect(prRequestOf(plan, newTicket, "pr")).toEqual({
            mode: "pr",
            createticket: true,
            newticket: "Declare the release pipeline",
        });
        expect(prRequestOf(plan, newTicket, "patch")).toEqual({ mode: "patch" });
        expect(prRequestOf({ ...plan, ticketrequired: false }, newTicket, "pr")).toEqual({ mode: "pr" });
        expect(
            prRequestOf({ ...plan, uncommitted: true, included: true }, { ticket: 3, create: false, title: "" }, "pr")
        ).toEqual({
            mode: "pr",
            ticket: 3,
            includelocal: true,
            localbase: "l",
        });
    });

    it("fills the ticket into the branch and the commit, and needs a git repository", () => {
        expect(prNamesOf(plan, 7)).toEqual({
            branch: "feature/7-release-pipeline",
            subject: "chore(#7): set up the release pipeline",
        });
        expect(prNamesOf(plan, 0).branch).toBe("feature/{N}-release-pipeline");
        expect(canOpenPr(plan, { ticket: 0, create: false, title: "" }, "pr")).toBe(false);
        expect(canOpenPr(plan, { ticket: 0, create: false, title: "" }, "patch")).toBe(true);
        expect(canOpenPr(plan, newTicket, "pr")).toBe(true);
        expect(canOpenPr({ ...plan, git: false }, newTicket, "patch")).toBe(false);
    });

    it("shows where the pull request starts and goes before the click", () => {
        const html = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={{ ticket: 7, create: false, title: "" }}
                onChoice={() => {}}
                job={null}
                busy={false}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(html).toContain("Validate by pull request");
        expect(html).toContain("Your working copy is not touched.");
        expect(html).toContain("feature/7-release-pipeline");
        expect(html).toContain("chore(#7): set up the release pipeline");
        expect(html).toContain("from origin/develop at abc1234");
        expect(html).toContain('data-testid="setup-ticket"');
        expect(html).toContain("The Release menu uses the pipeline once the pull request is merged into develop.");
    });

    it("follows the job step by step", () => {
        const html = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={newTicket}
                onChoice={() => {}}
                job={job({})}
                busy={true}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(html).toContain("a separate worktree from origin/develop (your checkout stays as it is)");
        expect(html).toMatch(/data-testid="setup-pr-step-push" data-state="running"/);
        expect(html).toMatch(/data-testid="setup-pr-step-pr" data-state="pending"/);
        expect(html).toContain("feature/7-release-pipeline");
    });

    it("says what stopped the job, and offers to prepare again when develop moved", () => {
        const exists = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={newTicket}
                onChoice={() => {}}
                job={job({ finished: true, failure: { code: "branchExists" } })}
                busy={false}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(exists).toContain("The branch feature/7-release-pipeline already exists on origin. Nothing was pushed");
        expect(exists).not.toContain("setup-pr-again");
        const moved = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={newTicket}
                onChoice={() => {}}
                job={job({ finished: true, failure: { code: "moved", commit: "9a1f3e0" } })}
                busy={false}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(moved).toContain(
            "origin/develop moved since the draft: .molten/project.json changed there (commit 9a1f3e0)."
        );
        expect(moved).toContain('data-testid="setup-pr-again"');
    });

    it("names the ignore rules the commit went past (#1146)", () => {
        const html = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={newTicket}
                onChoice={() => {}}
                job={job({
                    ignored: [
                        {
                            source: ".git/info/exclude",
                            pattern: ".molten/",
                            shared: false,
                            files: [".molten/project.json", ".molten/release-setup.json"],
                        },
                        {
                            source: ".gitignore",
                            pattern: "docs/engineering/",
                            shared: true,
                            files: ["docs/engineering/release-pipeline.md"],
                        },
                    ],
                })}
                busy={true}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(html).toContain(
            "This computer&#x27;s git settings ignore .molten/ (.git/info/exclude); the pull request adds these files anyway: .molten/project.json, .molten/release-setup.json."
        );
        expect(html).toContain("The project&#x27;s .gitignore ignores docs/engineering/");
        expect(html).toContain("a new file there needs git add -f");
        const failed = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={newTicket}
                onChoice={() => {}}
                job={job({ finished: true, ticket: 1114, failure: { code: "push" } })}
                busy={false}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(failed).toContain("feature/1114-release-pipeline");
        const none = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={newTicket}
                onChoice={() => {}}
                job={job({})}
                busy={true}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(none).not.toContain("setup-pr-ignored");
    });

    it("links the opened pull request", () => {
        const html = renderToStaticMarkup(
            <PrPanel
                dir="/p"
                plan={plan}
                choice={newTicket}
                onChoice={() => {}}
                job={job({ finished: true, prurl: "https://github.com/o/r/pull/42", prnumber: 42 })}
                busy={false}
                error={null}
                onAgain={() => {}}
            />
        );
        expect(html).toContain("Pull request #42 opened as a draft.");
        expect(html).toContain("Open #42");
        expect(
            renderToStaticMarkup(
                <PrFooterButtons
                    plan={plan}
                    job={job({ finished: true, prurl: "u", prnumber: 42 })}
                    busy={false}
                    canOpen={true}
                    canPatch={true}
                    onOpen={() => {}}
                />
            )
        ).toBe("");
    });

    it("makes the patch the action outside GitHub", () => {
        const html = renderToStaticMarkup(
            <PrFooterButtons
                plan={{ ...plan, ongithub: false }}
                job={null}
                busy={false}
                canOpen={true}
                canPatch={true}
                onOpen={() => {}}
            />
        );
        expect(html).toContain("Copy the patch");
        expect(html).toContain("molten-btn");
        expect(html).not.toContain("Open the pull request");
        const github = renderToStaticMarkup(
            <PrFooterButtons plan={plan} job={null} busy={false} canOpen={true} canPatch={true} onOpen={() => {}} />
        );
        expect(github).toContain("Open the pull request");
        expect(github).toContain("Copy the patch");
    });

    it("flags uncommitted pipeline edits and offers to include them", () => {
        const html = renderToStaticMarkup(
            <UncommittedNotice plan={{ ...plan, uncommitted: true, local: "{}" }} current="{}" onInclude={() => {}} />
        );
        expect(html).toContain(".molten/project.json has uncommitted changes in your checkout.");
        expect(html).toContain("Include them as changes to check");
        const included = renderToStaticMarkup(
            <UncommittedNotice
                plan={{ ...plan, uncommitted: true, included: true }}
                current="{}"
                onInclude={() => {}}
            />
        );
        expect(included).toContain("Leave them out");
        expect(renderToStaticMarkup(<UncommittedNotice plan={plan} current="{}" onInclude={() => {}} />)).toBe("");
    });
});
