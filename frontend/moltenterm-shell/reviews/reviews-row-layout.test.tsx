// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReviewPr } from "./reviews-model";
import { ReviewRow } from "./reviews-view";

const BarMarkup = `<div data-testid="row-agent-bar"></div>`;

// The real bar needs wavesrv's agent facts; a stub stands for "an agent works on the PR's branch".
vi.mock("./reviews-agent-bar", () => ({
    RowAgentLine: () => <div data-testid="row-agent-bar" />,
    DraftTurnChip: () => null,
    HeadStillFailsLine: () => null,
}));

function pr(): ReviewPr {
    return {
        number: 922,
        title: "PR 922",
        url: "https://github.com/a/b/pull/922",
        branch: "feature/922-x",
        base: "develop",
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "none", success: 0, failure: 0, pending: 0, checks: [] },
        report: { state: "unknown" },
        unpublished: 0,
    };
}

describe("Reviews tile layout (#923)", () => {
    // #954: the signature joined the agent line, the PR's one "who" line.
    it("keeps the agent line as the tile's last child", () => {
        const html = renderToStaticMarkup(
            <ReviewRow
                pr={pr()}
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
        expect(html.endsWith(`${BarMarkup}</div>`)).toBe(true);
        expect(html).not.toContain(`data-testid="reviews-signature"`);
    });
});
