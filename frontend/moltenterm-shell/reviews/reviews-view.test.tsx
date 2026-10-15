// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { isValidElement, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWebLink } from "../open-web-link";
import { MarkReadyState } from "./reviews-mark-ready";
import { ReviewPr } from "./reviews-model";
import { AssistedReviewLink, ReviewRow, ReviewRowActions } from "./reviews-view";

vi.mock("../open-web-link", () => ({ openWebLink: vi.fn(async () => true) }));

// The action components are called as plain functions to reach their click handlers (no DOM in these tests), so
// their one hook, useT, resolves without React.
vi.mock("../i18n/i18n", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../i18n/i18n")>();
    return { ...actual, useT: () => actual.t };
});

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "none", success: 0, failure: 0, pending: 0, checks: [] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

const idleMarkReady: MarkReadyState = { phase: "idle", error: "", ask: () => {}, confirm: () => {}, cancel: () => {} };

function findAll(node: ReactNode, match: (el: ReactElement<any>) => boolean): ReactElement<any>[] {
    if (Array.isArray(node)) {
        return node.flatMap((n) => findAll(n, match));
    }
    if (!isValidElement(node)) {
        return [];
    }
    const el = node as ReactElement<any>;
    return [...(match(el) ? [el] : []), ...findAll(el.props.children, match)];
}

function byTestId(node: ReactNode, id: string): ReactElement<any> {
    return findAll(node, (el) => el.props["data-testid"] === id)[0];
}

function click(el: ReactElement<any>) {
    const e = { stopPropagation: vi.fn() };
    el.props.onClick(e);
    return e;
}

function rowHtml(p: ReviewPr): string {
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
            repo="a/b"
        />
    );
}

describe("Reviews row (#708)", () => {
    beforeEach(() => {
        vi.mocked(openWebLink).mockClear();
    });

    it("AC1: names the assisted review on hover and keyboard focus only, laid out so it never shifts the chips", () => {
        const html = rowHtml(pr(12));
        const link = /<button[^>]*data-testid="reviews-assisted-review"[^>]*>/.exec(html)?.[0];
        expect(link).toBeTruthy();
        expect(link).toContain('aria-label="Open the assisted review of PR #12"');
        expect(link).toMatch(/\bopacity-0\b/);
        expect(link).toContain("group-hover:opacity-100");
        expect(link).toContain("group-focus-visible:opacity-100");
        expect(link).toContain("focus-visible:opacity-100");
        expect(link).toContain("motion-reduce:translate-x-0");
        expect(link).not.toMatch(/\b(hidden|absolute)\b/);
        expect(html).toContain("Assisted review</span>");
        expect(html).toMatch(/role="listitem"[^>]*class="group @container/);
        expect(html).not.toMatch(/role="listitem"[^>]*title=/);
    });

    it("AC2: the link opens the assisted review, as the tile does, without the row's own click", () => {
        const onOpen = vi.fn();
        const e = click(AssistedReviewLink({ number: 12, onOpen }) as ReactElement<any>);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(e.stopPropagation).toHaveBeenCalled();
    });

    it("AC2: Validate merges through its sheet and GitHub opens the PR page; neither opens the review", () => {
        const onValidate = vi.fn();
        const actions = ReviewRowActions({ pr: pr(12), blocked: "", markReady: idleMarkReady, onValidate });
        const validate = click(byTestId(actions, "reviews-validate"));
        expect(onValidate).toHaveBeenCalledTimes(1);
        expect(validate.stopPropagation).toHaveBeenCalled();
        const github = click(byTestId(actions, "reviews-github"));
        expect(openWebLink).toHaveBeenCalledWith("https://github.com/a/b/pull/12");
        expect(github.stopPropagation).toHaveBeenCalled();
    });

    it("a blocked Validate does nothing", () => {
        const onValidate = vi.fn();
        const actions = ReviewRowActions({ pr: pr(12), blocked: "CI failed", markReady: idleMarkReady, onValidate });
        click(byTestId(actions, "reviews-validate"));
        expect(onValidate).not.toHaveBeenCalled();
    });

    it("a draft row keeps Mark ready in place of Validate", () => {
        const html = rowHtml(pr(13, { draft: true }));
        expect(html).not.toContain('data-testid="reviews-validate"');
        expect(html).toContain('data-testid="reviews-github"');
        expect(html).toContain('data-testid="reviews-assisted-review"');
    });
});
