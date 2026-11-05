// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1921 (FR-REV-001 AC19): the ticket number and the PR number of an Integration card open their page, in the one way
// the app opens an address read from GitHub, and stop there: the card's own click is not also run.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";
import { issueUrlOfPr, ticketLinkUrl } from "./reviews-links-model";
import { ReviewPr } from "./reviews-model";
import { NumberLink, numberLinkHandlers } from "./reviews-number-link";
import { ReviewRow } from "./reviews-view";

vi.mock("../open-web-link", () => ({ openWebLink: vi.fn(async () => true) }));

vi.mock("./reviews-agent-bar", () => ({
    RowAgentLine: () => <div data-testid="row-agent-bar" />,
    useCardContext: () => ({ upcoming: null, states: null, now: 0, boardText: (s: string) => s }),
    useHeadStillFails: () => [],
}));

function pr(extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number: 1144,
        title: "Number links",
        url: "https://github.com/acme/app/pull/1144",
        branch: "feature/1124-number-links",
        base: "develop",
        createdat: "2026-11-04T10:00:00Z",
        updatedat: "2026-11-05T10:00:00Z",
        merge: "clean",
        ci: { state: "none", success: 0, failure: 0, pending: 0, checks: [] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

function row(p: ReviewPr) {
    return renderToStaticMarkup(
        <ReviewRow
            pr={p}
            selected={false}
            marked={false}
            onSelect={() => {}}
            onOpen={() => {}}
            onValidate={() => {}}
            onAskRebase={async () => null}
            rebaseAsk={null}
            dir="/p"
            repo="acme/app"
        />
    );
}

// The opening tag of the element carrying a test id.
function tagOf(html: string, testId: string): string {
    const at = html.indexOf(`data-testid="${testId}"`);
    expect(at, testId).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

describe("where the numbers lead (#1921)", () => {
    it("builds the issue page from the pull request's own address", () => {
        expect(issueUrlOfPr("https://github.com/acme/app/pull/1144", 1124)).toBe(
            "https://github.com/acme/app/issues/1124"
        );
        expect(issueUrlOfPr("https://git.example.org/team/app/pull/7/", 3)).toBe(
            "https://git.example.org/team/app/issues/3"
        );
    });

    it("builds nothing it would have to guess", () => {
        expect(issueUrlOfPr("", 1124)).toBe("");
        expect(issueUrlOfPr("https://github.com/acme/app", 1124)).toBe("");
        expect(issueUrlOfPr("https://github.com/acme/app/pull/1144", 0)).toBe("");
        expect(ticketLinkUrl(0, "https://tracker.example/T-1", "https://github.com/acme/app/pull/1144")).toBe("");
    });

    it("prefers the address the workflow tool gave for the ticket", () => {
        const given = "https://github.com/acme/app/issues/1124";
        expect(ticketLinkUrl(1124, given, "https://github.com/other/repo/pull/1")).toBe(given);
        expect(ticketLinkUrl(1124, "", "https://github.com/acme/app/pull/1144")).toBe(given);
    });
});

describe("a number as a link (#1921)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });
    afterEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
        vi.mocked(openWebLink).mockClear();
    });

    it("names what it opens, in English and in French", () => {
        const ticket = (
            <NumberLink kind="ticket" number={1124} url="https://github.com/acme/app/issues/1124">
                #1124
            </NumberLink>
        );
        const prLink = (
            <NumberLink kind="pr" number={1144} url="https://github.com/acme/app/pull/1144">
                PR #1144
            </NumberLink>
        );
        expect(renderToStaticMarkup(ticket)).toContain('aria-label="Open ticket #1124"');
        expect(renderToStaticMarkup(prLink)).toContain('aria-label="Open pull request #1144"');
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(renderToStaticMarkup(ticket)).toContain('aria-label="Ouvrir le ticket #1124"');
        expect(renderToStaticMarkup(prLink)).toContain('aria-label="Ouvrir la pull request #1144"');
    });

    it("looks like a link: a button with a pointer and an underline on hover and focus", () => {
        const html = renderToStaticMarkup(
            <NumberLink kind="pr" number={1144} url="https://github.com/acme/app/pull/1144" className="text-muted">
                PR #1144
            </NumberLink>
        );
        expect(html).toMatch(/^<button type="button"/);
        for (const cls of ["cursor-pointer", "hover:underline", "hover:text-primary", "focus-visible:underline"]) {
            expect(html).toContain(cls);
        }
        expect(html).toContain("text-muted");
        expect(html).toContain('data-url="https://github.com/acme/app/pull/1144"');
    });

    it("stays plain text with no address to open", () => {
        const html = renderToStaticMarkup(
            <NumberLink kind="ticket" number={1124} url="" testId="n">
                #1124
            </NumberLink>
        );
        expect(html).toBe('<span data-testid="n">#1124</span>');
    });

    it("opens its page through the app's one way to open an address, and stops there", () => {
        const url = "https://github.com/acme/app/issues/1124";
        const click = { stopPropagation: vi.fn() };
        numberLinkHandlers(url).onClick(click as unknown as React.SyntheticEvent);
        expect(click.stopPropagation).toHaveBeenCalledTimes(1);
        expect(openWebLink).toHaveBeenCalledTimes(1);
        expect(openWebLink).toHaveBeenCalledWith(url);
    });

    it("keeps its keys from the card, which opens its review on Enter, without opening twice", () => {
        const key = { stopPropagation: vi.fn() };
        numberLinkHandlers("https://github.com/acme/app/issues/1124").onKeyDown(key as unknown as React.SyntheticEvent);
        expect(key.stopPropagation).toHaveBeenCalledTimes(1);
        expect(openWebLink).not.toHaveBeenCalled();
    });
});

describe("the numbers of an Integration card (#1921)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("links the ticket to its issue and the PR chip to the pull request", () => {
        const html = row(pr({ ticket: 1124, tickettitle: "Number links" }));
        const ticket = tagOf(html, "reviews-card-number");
        expect(ticket).toContain('aria-label="Open ticket #1124"');
        expect(ticket).toContain('data-url="https://github.com/acme/app/issues/1124"');
        const chip = tagOf(html, "reviews-card-pr");
        expect(chip).toContain('aria-label="Open pull request #1144"');
        expect(chip).toContain('data-url="https://github.com/acme/app/pull/1144"');
        expect(html).toContain(">#1124</button>");
        expect(html).toContain(">PR #1144</button>");
    });

    it("opens the ticket address the workflow tool gave", () => {
        const given = "https://github.com/acme/tickets/issues/1124";
        const html = row(pr({ ticket: 1124, ticketurl: given }));
        expect(tagOf(html, "reviews-card-number")).toContain(`data-url="${given}"`);
    });

    it("links the one number of a card without a ticket to its pull request", () => {
        const html = row(pr());
        const number = tagOf(html, "reviews-card-number");
        expect(number).toContain('aria-label="Open pull request #1144"');
        expect(number).toContain('data-url="https://github.com/acme/app/pull/1144"');
        expect(html).not.toContain('data-testid="reviews-card-pr"');
    });

    it("leaves the numbers as text when the PR has no address", () => {
        const html = row(pr({ url: "", ticket: 1124 }));
        expect(tagOf(html, "reviews-card-number")).not.toContain("data-link");
        expect(tagOf(html, "reviews-card-pr")).not.toContain("data-link");
        expect(html).not.toContain("Open ticket");
        expect(html).toContain("#1124");
        expect(html).toContain("PR #1144");
    });
});
