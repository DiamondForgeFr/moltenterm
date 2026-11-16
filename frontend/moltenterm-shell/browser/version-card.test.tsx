// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The version card as drawn (FR-BRW-017 AC7 to AC9, AC11, #2326): the current version marked with the liseré, the
// steps only when a test is asked, a stop confirmation naming the process, its pid, the branch and the port, the
// other projects and the details folded. Synthetic projects and branches only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyAgentStates } from "../agent-state-model";
import { t } from "../i18n/i18n";
import type { ReviewPr } from "../reviews/reviews-model";
import type { UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import type { TestContextAnswer } from "./test-context-model";
import { VersionCardView, type VersionCardViewProps } from "./version-card";
import { type ProjectFacts, type ServedVersions, versionCardData } from "./version-card-model";

const Now = 10 * 3_600_000;
const Dir = "/w/shop";

const Draft: ReviewPr = {
    number: 110,
    title: "Loader",
    url: "https://example.test/acme/shop/pull/110",
    branch: "feature/1-a",
    base: "develop",
    draft: true,
    ticket: 1,
    tickettitle: "Loader on the home page",
    createdat: "",
    updatedat: "",
    merge: "clean",
    ci: { state: "success", success: 0, failure: 0, pending: 0, checks: [] },
    report: { state: "present" },
    unpublished: 0,
};

function upcoming(status: string): UpcomingAnswer {
    return {
        dir: Dir,
        branches: [{ branch: "feature/2-b", ticket: 2, ahead: 1, title: "Basket total" }],
        agents: [],
        drafts: [{ branch: "feature/1-a", ticket: 1, status }],
        humantesting: "yes",
        at: Now,
    };
}

function project(status: string): ProjectFacts {
    return {
        dir: Dir,
        answer: { dir: Dir, state: "ok", ready: [], drafts: [Draft] },
        ctx: { upcoming: upcoming(status), states: EmptyAgentStates, now: Now, boardText: (s) => s },
    };
}

const Served: ServedVersions = {
    at: Now,
    versions: [
        {
            root: "/w/shop-wt/a",
            project: "/w/shop",
            name: "shop",
            worktree: true,
            branch: "feature/1-a",
            dirty: true,
            ticket: 1,
            pr: { number: 110, title: "Loader", url: "u", draft: true },
            projectdir: Dir,
            linked: true,
            servers: [{ port: 5173, pid: 41, process: "node" }],
        },
        {
            root: "/w/shop-wt/b",
            project: "/w/shop",
            name: "shop",
            worktree: true,
            branch: "feature/2-b",
            ticket: 2,
            futurepr: true,
            projectdir: Dir,
            linked: true,
            servers: [{ port: 5180, pid: 52, process: "node" }],
        },
        { root: "/w/blog", project: "/w/blog", name: "blog", branch: "main", servers: [{ port: 4000, pid: 70 }] },
    ],
};

const Answer: TestContextAnswer = {
    url: "http://localhost:5173/home",
    host: "localhost",
    port: 5173,
    known: true,
    pid: 41,
    process: "node",
    cwd: "/w/shop-wt/a",
    root: "/w/shop-wt/a",
    project: "/w/shop",
    name: "shop",
    worktree: true,
    branch: "feature/1-a",
    sha: "4f2a9c0d11aa",
    dirty: true,
    ticket: 1,
    pr: { number: 110, title: "Loader", url: "u", draft: true },
    prknown: true,
    sameproject: true,
    steps: ["Open the home page", "Wait for the loader"],
};

const Noop = () => {};

function draw(status: string, over: Partial<VersionCardViewProps> = {}, served: ServedVersions = Served): string {
    const data = versionCardData({ answer: Answer, served, projects: [project(status)], asks: {}, now: Now, t }, Dir);
    return renderToStaticMarkup(
        <VersionCardView
            data={data}
            stopAsk={null}
            stopping={null}
            outcome={null}
            onSwitch={Noop}
            onAskStop={Noop}
            onConfirmStop={Noop}
            onOpenReviews={Noop}
            onOpenPr={Noop}
            {...over}
        />
    );
}

function rows(html: string): string[] {
    return html.split('data-testid="browser-version-row"').slice(1);
}

describe("the version card (#2326)", () => {
    it("says where you are first: the ticket's title, its number, the branch and the uncommitted changes", () => {
        const html = draw("Human Testing");
        expect(html).toContain("Loader on the home page");
        expect(html).toContain("#1");
        expect(html).toContain("feature/1-a");
        expect(html).toContain("uncommitted changes");
        expect(html).toContain('data-testid="browser-version-mark"');
        expect(html).toContain("Open in Integration");
        expect(html).toContain("molten-btn");
    });

    it("marks the current version with the liseré, and opens only the others", () => {
        const html = draw("Human Testing");
        const [current, other] = rows(html);
        expect(current).toContain("mt-selected-action");
        expect(current).toContain('aria-current="true"');
        expect(current).toContain("you are here");
        expect(current).not.toContain("browser-version-open");
        expect(other).not.toContain("mt-selected-action");
        expect(other).toContain('data-testid="browser-version-open"');
        expect(other).toContain("Basket total");
        expect(other).toContain("port 5180");
    });

    it("lists the steps only while a test is asked", () => {
        const asked = draw("Human Testing");
        expect(asked).toContain("What to test");
        expect(asked).toContain("Open the home page");
        expect(asked).toContain('type="checkbox"');
        const working = draw("In progress");
        expect(working).not.toContain("What to test");
        expect(working).not.toContain("Open the home page");
    });

    it("asks before stopping, naming the process, its pid, the branch and the port", () => {
        const html = draw("Human Testing", { stopAsk: "/w/shop-wt/b" });
        expect(html).toContain('data-testid="browser-version-stop-confirm"');
        expect(html).toContain("Stop node, which serves feature/2-b on port 5180?");
        expect(html).toContain("molten-btn-destructive");
        expect(rows(html)[0]).not.toContain("browser-version-stop-confirm");
        expect(draw("Human Testing")).not.toContain("browser-version-stop-confirm");
    });

    it("offers no stop for a project linked to no workspace, and names a program whose name is unknown in words", () => {
        const unlinked: ServedVersions = {
            ...Served,
            versions: Served.versions.map((v) =>
                v.branch === "feature/2-b" ? { ...v, linked: false, servers: [{ port: 5180, pid: 52 }] } : v
            ),
        };
        const [current, other] = rows(draw("Human Testing", {}, unlinked));
        expect(current).toContain('data-testid="browser-version-stop"');
        expect(other).not.toContain('data-testid="browser-version-stop"');
        const linked: ServedVersions = {
            ...Served,
            versions: Served.versions.map((v) =>
                v.branch === "feature/2-b" ? { ...v, servers: [{ port: 5180, pid: 52 }] } : v
            ),
        };
        const html = draw("Human Testing", { stopAsk: "/w/shop-wt/b" }, linked);
        expect(html).toContain("Stop a program whose name cannot be read, which serves feature/2-b on port 5180?");
        expect(html).not.toContain("pid");
    });

    it("folds the other projects and the details", () => {
        const html = draw("Human Testing");
        expect(html).toContain("Other projects · 1");
        expect(html).not.toContain('data-testid="browser-versions-others"');
        expect(html).toContain('data-testid="browser-version-details-toggle"');
        expect(html).not.toContain('data-testid="browser-test-context-details"');
    });

    it("says what a stop did", () => {
        const html = draw("Human Testing", {
            outcome: { text: { key: "browser.testContext.stop.doneCurrent" }, bad: false },
        });
        expect(html).toContain("This version is stopped. Open another one below.");
    });
});
