// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The calls to action that open another panel beside theirs (#1844), each family's button as the developer sees it:
// present, and its tooltip tells how to open the panel in a new view.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewsLine } from "./mission/cicd-panels";
import { ShowCiButton } from "./mission/release-run-panel";
import type { SetupTechDocLink } from "./mission/release-setup-model";
import { TechDocLinkButton } from "./mission/release-techdoc-link";
import { CicdHeaderButton } from "./project/project-view";

const Hint = "(Shift-click: in a new view)";

describe("a call to action that opens a panel beside its own", () => {
    it("Release run: the card's link to the CI it waits on", () => {
        const html = renderToStaticMarkup(<ShowCiButton />);
        expect(html).toContain('data-testid="release-run-show-ci"');
        expect(html).toContain(`title="See it in CI/CD ${Hint}"`);
    });

    it("Project: the header's CI/CD button", () => {
        const html = renderToStaticMarkup(<CicdHeaderButton />);
        expect(html).toContain('data-testid="project-open-cicd"');
        expect(html).toContain(Hint);
    });

    it("CI/CD: the line to Integration", () => {
        const html = renderToStaticMarkup(<ReviewsLine github={{ prs: [] } as any} target="develop" dir="/shop" />);
        expect(html).toContain('data-testid="ci-remote-reviews-line"');
        expect(html).toContain(Hint);
    });

    it("Release menu: the link to the pipeline's documentation", () => {
        const doc = { backend: "repository", path: "/shop/docs/pipeline.md" } as SetupTechDocLink;
        const html = renderToStaticMarkup(<TechDocLinkButton doc={doc} onOpen={() => {}} />);
        expect(html).toContain('data-testid="release-techdoc-link"');
    });
});
