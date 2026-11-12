// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import type { ReviewsAnswer } from "./reviews-model";
import { projectSectionCounts, ProjectSectionsBlock } from "./reviews-projects";
import type { UpcomingAnswer } from "./reviews-upcoming-model";

// The sections themselves are the single-project view's, tested on their own: here only which of them a block shows.
vi.mock("./reviews-upcoming", () => ({
    UpcomingSection: ({ dir }: { dir: string }) => <div data-testid="stub-upcoming">{dir}</div>,
}));
vi.mock("./reviews-merged", () => ({
    MergedSection: ({ answer }: { answer: ReviewsAnswer }) => <div data-testid="stub-merged">{answer.dir}</div>,
}));

const ProjectA: WorkspaceProjectEntry = { id: "pa", type: "Desktop", dir: "/synthetic/a", branch: "main" };

function answer(extra: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return { dir: "/synthetic/a", state: "ok", repo: "example/a", target: "develop", ready: [], drafts: [], ...extra };
}

function upcoming(extra: Partial<UpcomingAnswer> = {}): UpcomingAnswer {
    return { dir: "/synthetic/a", branches: [], agents: [], at: 1, ...extra };
}

const merged = {
    number: 9,
    title: "Synthetic merged",
    url: "https://example.invalid/pull/9",
    branch: "fix/9-x",
    base: "develop",
    author: "dev",
    mergedat: "2026-11-10T10:00:00Z",
    mergedby: "dev",
};

describe("All projects shows each project's Coming and Recently merged (#2280)", () => {
    it("counts a ticket branch without its pull request as coming, and the merged pull requests", () => {
        const counts = projectSectionCounts(
            answer({ merged: [merged] }),
            upcoming({ branches: [{ branch: "fix/12-coming", ticket: 12, ahead: 2 }] }),
            null
        );
        expect(counts).toEqual({ coming: 1, merged: 1 });
    });

    it("does not count a branch whose pull request is open, nor anything of a project that failed to read", () => {
        const pr = { number: 3, branch: "fix/12-coming", ticket: 12 } as ReviewsAnswer["ready"][number];
        const counts = projectSectionCounts(
            answer({ ready: [pr] }),
            upcoming({ branches: [{ branch: "fix/12-coming", ticket: 12, ahead: 2 }] }),
            null
        );
        expect(counts).toEqual({ coming: 0, merged: 0 });
        expect(projectSectionCounts(answer({ state: "error", merged: [merged] }), null, null)).toEqual({
            coming: 0,
            merged: 0,
        });
    });

    it("names the project, links to its view and shows only the sections that hold something", () => {
        const onlyComing = renderToStaticMarkup(
            <ProjectSectionsBlock
                block={{ project: ProjectA, coming: 1, merged: 0 }}
                answer={answer()}
                names={null}
                onOpen={() => {}}
            />
        );
        expect(onlyComing).toContain("Desktop");
        expect(onlyComing).toContain('data-testid="reviews-all-project-open"');
        expect(onlyComing).toContain("stub-upcoming");
        expect(onlyComing).not.toContain("stub-merged");

        const onlyMerged = renderToStaticMarkup(
            <ProjectSectionsBlock
                block={{ project: ProjectA, coming: 0, merged: 1 }}
                answer={answer({ merged: [merged] })}
                names={null}
                onOpen={() => {}}
            />
        );
        expect(onlyMerged).toContain("stub-merged");
        expect(onlyMerged).not.toContain("stub-upcoming");
    });
});
