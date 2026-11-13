// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import type { ReviewsAnswer } from "./reviews-model";
import { ProjectSectionsBlock } from "./reviews-projects";

// The sections themselves are the single-project view's, tested on their own: here only what a block holds.
vi.mock("./reviews-upcoming", () => ({
    UpcomingSection: ({ dir }: { dir: string }) => <div data-testid="stub-upcoming">{dir}</div>,
}));
vi.mock("./reviews-merged", () => ({
    MergedSection: ({ answer }: { answer: ReviewsAnswer }) => <div data-testid="stub-merged">{answer.dir}</div>,
}));
vi.mock("./reviews-notes-view", () => ({
    NotesSection: ({ repo }: { repo: string }) => <div data-testid="stub-notes">{repo}</div>,
}));

const ViewSource = readFileSync(new URL("./reviews-view.tsx", import.meta.url), "utf8");

const ProjectA: WorkspaceProjectEntry = { id: "pa", type: "Desktop", dir: "/synthetic/a", branch: "main" };

function answer(extra: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return { dir: "/synthetic/a", state: "ok", repo: "example/a", target: "develop", ready: [], drafts: [], ...extra };
}

function block(props: Partial<Parameters<typeof ProjectSectionsBlock>[0]> = {}): string {
    return renderToStaticMarkup(
        <ProjectSectionsBlock
            project={ProjectA}
            answer={answer()}
            blockId="b1"
            names={null}
            listed={0}
            hidden={false}
            onOpen={() => {}}
            {...props}
        />
    );
}

function classesOf(html: string, testId: string): string[] {
    const tag = html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
    return (tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

describe("All projects shows each project as its own view does (#2280, #2291)", () => {
    it("names the project and its trunk, links to its view, and shows every section, empty ones included", () => {
        const html = block();
        expect(html).toContain("Desktop");
        expect(html).toContain("<code>develop</code>");
        expect(html).toContain('data-testid="reviews-all-project-open"');
        expect(html).toContain('data-testid="reviews-none-open"');
        expect(html).toContain("No pull request open into <code>develop</code>.");
        expect(html).toContain("stub-upcoming");
        expect(html).toContain("stub-notes");
        expect(html).toContain("stub-merged");
    });

    it("says none is open only when the lanes above list none of its pull requests", () => {
        expect(block({ listed: 2 })).not.toContain("reviews-none-open");
        expect(block({ listed: 0, hidden: true })).toContain("reviews-none-open");
        expect(block({ listed: 0, hidden: true })).not.toContain("No pull request open into");
    });

    it("shows nothing for a project whose pull requests could not be read", () => {
        expect(block({ answer: undefined })).toBe("");
        expect(block({ answer: answer({ state: "norepo" }) })).toBe("");
    });

    it("draws no line of its own at the top of the list, so the header's line stays the only one", () => {
        const html = block();
        const own = classesOf(html, "reviews-all-project-sections");
        // A block separates itself from what precedes it; first in the list, the header above already has its line.
        expect(own).toContain("border-t");
        expect(own).toContain("first:border-t-0");
        expect(own).toContain("first:pt-0");
        // Nothing the block holds draws a second line across it.
        expect(html.replace(/<section[^>]*data-testid="reviews-all-project-sections"[^>]*>/, "")).not.toMatch(
            /class="[^"]*\bborder-t\b/
        );
    });

    it("draws the single-project view's bottom part with the same shared components", () => {
        expect(ViewSource).toContain("<ProjectTail ");
        expect(ViewSource).toContain("<NoneOpenLine ");
        expect(ViewSource).not.toMatch(/import \{[^}]*\b(UpcomingSection|MergedSection|NotesSection)\b/);
    });
});
