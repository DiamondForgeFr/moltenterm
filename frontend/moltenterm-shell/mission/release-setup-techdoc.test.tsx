// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./release-setup-client", () => ({
    setupTechDoc: vi.fn(),
    setupDraft: vi.fn(),
    setupWrite: vi.fn(),
    setupCheck: vi.fn(),
    setupUpdate: vi.fn(),
}));
vi.mock("@/app/store/global", () => ({ createBlock: vi.fn(), openLink: vi.fn(), getApi: vi.fn() }));

import { createBlock } from "@/app/store/global";
import { TechDocChanges, techDocCounts, techDocFile } from "./release-setup-techdoc";
import { openTechDoc, TechDocLinkButton } from "./release-techdoc-link";

describe("pipeline technical documentation (FR-MC-043)", () => {
    it("counts the document's changed lines", () => {
        const plan = {
            backend: "repository",
            topic: "release-pipeline",
            title: "Release pipeline",
            path: "docs/engineering/release-pipeline.md",
            current: "# A\nsame\nold\n",
            proposed: "# A\nsame\nnew\nmore\n",
            warnings: [],
        };
        expect(techDocCounts(plan)).toEqual({ added: 2, removed: 1 });
        expect(techDocCounts(null)).toEqual({ added: 0, removed: 0 });
    });

    it("is one more generated file of step 3's list, closed, with its diff from the current one", () => {
        const plan = {
            backend: "repository",
            topic: "release-pipeline",
            title: "Release pipeline",
            path: "docs/engineering/release-pipeline.md",
            current: "# Old\n",
            proposed: "# New\n",
            warnings: ["fake: unreachable"],
        };
        expect(techDocFile(plan)).toEqual({
            path: "docs/engineering/release-pipeline.md",
            status: "changed",
            kind: "whole",
            content: "# New\n",
            before: "# Old\n",
            collapsed: true,
            introKey: "mc.setup.techdoc.introRepository",
            warningKey: "mc.setup.techdoc.fallback",
            warningVars: { reason: "fake: unreachable" },
        });
        const page = techDocFile({ ...plan, backend: "saasfoundry", path: "", current: "", warnings: [] });
        expect(page.path).toBe("Release pipeline");
        expect(page.status).toBe("new");
        expect(page.introKey).toBe("mc.setup.techdoc.introBackend");
        expect(techDocFile({ ...plan, proposed: "" })).toBeNull();
    });

    it("shows the block while the document is built, and nothing without a pipeline", () => {
        const html = renderToStaticMarkup(<TechDocChanges dir="/p" text="{}" kind="write" />);
        expect(html).toContain("Technical documentation");
        expect(html).toContain("building the documentation from the pipeline");
        expect(renderToStaticMarkup(<TechDocChanges dir="/p" text="" kind="write" />)).toBe("");
    });

    it("links the Release menu to the document, the file in a preview panel", () => {
        expect(renderToStaticMarkup(<TechDocLinkButton doc={{ backend: "repository" }} onOpen={() => {}} />)).toBe("");
        const html = renderToStaticMarkup(
            <TechDocLinkButton
                doc={{ backend: "repository", path: "/p/docs/engineering/release-pipeline.md" }}
                onOpen={() => {}}
            />
        );
        expect(html).toContain("How this project ships");
        expect(html).toContain("cursor-pointer");
        openTechDoc({ backend: "repository", path: "/p/docs/engineering/release-pipeline.md" });
        expect(createBlock).toHaveBeenCalledWith({
            meta: { view: "preview", file: "/p/docs/engineering/release-pipeline.md" },
        });
    });
});
