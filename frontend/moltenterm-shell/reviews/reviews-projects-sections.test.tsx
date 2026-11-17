// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2314, FR-SHELL-087: Integration's All projects draws one Upcoming, one Notes and one Recently merged for every
// project, each card marked with its project, and what is wrong with a project as one line at the top. Synthetic
// project names only; the single-project view stays on its own components.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { setTestMatrix } from "../agent-info/agent-features-fixture";
import type { ReviewNote } from "../review/review-notes";
import type { WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import { sourceOf, type AllSource, type ProjectMarkFacts } from "./reviews-all-model";
import {
    AllLane,
    AllMergedSection,
    AllNoneOpenLine,
    AllNotesSection,
    AllProblemLines,
    AllUpcomingSection,
} from "./reviews-all-sections";
import type { ReviewMergedPr } from "./reviews-merged-model";
import type { ReviewsAnswer } from "./reviews-model";
import { chooseProject, ProjectMark } from "./reviews-project-mark";
import type { UpcomingAnswer, UpcomingBranch, UpcomingLeftover } from "./reviews-upcoming-model";

// The settings, as the app's global atoms give them once initialised.
vi.mock("@/app/store/global", async (importOriginal) => {
    const { atom } = await import("jotai");
    const fullConfigAtom = atom(null);
    const settingsAtom = atom((get) => (get(fullConfigAtom) as any)?.settings ?? {});
    return {
        ...(await importOriginal<object>()),
        atoms: { fullConfigAtom, settingsAtom },
        getSettingsKeyAtom: (key: string) => atom((get) => (get(settingsAtom) as any)[key]),
    };
});

// What a card's actions would act on, shown in the markup: the folder of the project each one belongs to.
vi.mock("./reviews-launch", () => ({
    LaunchCardActions: ({ dir }: { dir: string }) => <i data-launch-dir={dir} />,
    LaunchBackButton: ({ dir, trunk }: { dir: string; trunk: string }) => (
        <i data-back-dir={dir} data-back-trunk={trunk} />
    ),
    LaunchDialogs: () => null,
}));

setTestMatrix();

const Desktop: WorkspaceProjectEntry = { id: "p1", type: "Desktop", dir: "/synthetic/desk", branch: "" };
const Mobile: WorkspaceProjectEntry = { id: "p2", type: "Mobile", dir: "/synthetic/mob", branch: "" };
const Website: WorkspaceProjectEntry = { id: "p3", type: "Website", dir: "/synthetic/web", branch: "" };
const NoFolder: WorkspaceProjectEntry = { id: "p4", type: "Library", dir: "", branch: "" };

const Marks = { place: false, onChoose: () => {} };

function answer(project: WorkspaceProjectEntry, target: string, over: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return {
        dir: project.dir,
        state: "ok",
        repo: `example/${project.id}`,
        url: `https://example.test/${project.id}`,
        target,
        ready: [],
        drafts: [],
        ...over,
    } as ReviewsAnswer;
}

function branch(ticket: number, commitat: number): UpcomingBranch {
    return { branch: `feature/${ticket}-x`, ticket, ahead: 1, commitat, title: `Ticket ${ticket}` };
}

function upcoming(branches: UpcomingBranch[], leftovers: UpcomingLeftover[] = []): UpcomingAnswer {
    return { dir: "/x", branches, agents: [], leftovers, at: 1 };
}

function note(id: string, keptat: number): ReviewNote {
    return {
        id,
        title: `Note ${id}`,
        explanationid: id,
        markdown: "text",
        pr: { number: 3, title: "A change" },
        keptat,
    };
}

function merged(number: number, over: Partial<ReviewMergedPr> = {}): ReviewMergedPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://example.test/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        mergedat: "2026-01-02T10:00:00Z",
        ships: "next",
        ...over,
    };
}

function count(html: string, testId: string): number {
    return (html.match(new RegExp(`data-testid="${testId}"`, "g")) ?? []).length;
}

function attrs(html: string, name: string): string[] {
    return [...html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1]);
}

// A button inside a button is invalid HTML: no card nests its mark in its own button.
function deepestButton(html: string): number {
    let depth = 0;
    let deepest = 0;
    for (const m of html.matchAll(/<(\/?)button\b[^>]*>/g)) {
        depth += m[1] ? -1 : 1;
        deepest = Math.max(deepest, depth);
    }
    return deepest;
}

function upcomingHtml(sources: AllSource[], marks = Marks): string {
    return renderToStaticMarkup(<AllUpcomingSection sources={sources} names={null} marks={marks} />);
}

const Busy: AllSource[] = [
    sourceOf(Desktop, { answer: answer(Desktop, "develop"), upcoming: upcoming([branch(1, 100), branch(2, 10)]) }),
    sourceOf(Mobile, { answer: answer(Mobile, "main"), upcoming: upcoming([branch(7, 50)]) }),
    sourceOf(Website, { answer: answer(Website, "develop"), upcoming: upcoming([]) }),
];

const Quiet: AllSource[] = [Desktop, Mobile, Website].map((p) =>
    sourceOf(p, { answer: answer(p, "develop"), upcoming: upcoming([]), notes: { repo: `example/${p.id}`, notes: [] } })
);

describe("Upcoming is one section for every project", () => {
    it("lists the cards of every project once, each with its project's mark, the most recent first", () => {
        const html = upcomingHtml(Busy);
        expect(count(html, "reviews-upcoming-toggle")).toBe(1);
        expect(count(html, "reviews-upcoming")).toBe(1);
        expect(count(html, "reviews-upcoming-row")).toBe(3);
        expect(count(html, "reviews-project-mark")).toBe(3);
        expect(attrs(html, "data-project")).toEqual(["p1", "p2", "p1"]);
        expect(attrs(html, "data-branch")).toEqual(["feature/1-x", "feature/7-x", "feature/2-x"]);
        expect(html).not.toContain("reviews-upcoming-empty");
        expect(deepestButton(html)).toBe(1);
    });

    it("keeps a card's actions on its own project", () => {
        const html = upcomingHtml(Busy);
        expect(attrs(html, "data-launch-dir")).toEqual(["/synthetic/desk", "/synthetic/mob", "/synthetic/desk"]);
        // The ticket link and the mark's choice are the card's project's too: a project is told by its own id.
        expect(html).toContain("https://example.test/p2/issues/7");
        expect(html).toContain("https://example.test/p1/issues/1");
    });

    it("says nothing is waiting once, not once per project, and names no project in it", () => {
        const html = upcomingHtml(Quiet);
        expect(count(html, "reviews-upcoming-empty")).toBe(1);
        expect(count(html, "reviews-upcoming-toggle")).toBe(1);
        expect(html).toContain("No ticket branch is waiting for its pull request.");
        for (const name of ["Desktop", "Mobile", "Website"]) {
            expect(html).not.toContain(name);
        }
    });

    it("does not say nothing is waiting before every project's upcoming work answered", () => {
        const waiting = [...Quiet.slice(0, 2), sourceOf(Website, { answer: answer(Website, "develop") })];
        expect(count(upcomingHtml(waiting), "reviews-upcoming-empty")).toBe(0);
        expect(
            count(upcomingHtml([sourceOf(Website, { answer: answer(Website, "develop") })]), "reviews-upcoming-empty")
        ).toBe(0);
    });

    it("lists the cards that are there while another project has not answered yet", () => {
        const html = upcomingHtml([Busy[1], sourceOf(Website, { answer: answer(Website, "develop") })]);
        expect(count(html, "reviews-upcoming-row")).toBe(1);
    });

    it("groups the leftovers of every project in one group, each card marked", () => {
        const leftover = (pr: number): UpcomingLeftover => ({ branch: `feature/${pr}-x`, pr, title: `Done ${pr}` });
        const html = upcomingHtml([
            sourceOf(Desktop, { answer: answer(Desktop, "develop"), upcoming: upcoming([], [leftover(4)]) }),
            sourceOf(Mobile, { answer: answer(Mobile, "main"), upcoming: upcoming([], [leftover(5)]) }),
            sourceOf(Website, { answer: answer(Website, "develop"), upcoming: upcoming([]) }),
        ]);
        expect(count(html, "reviews-leftovers-toggle")).toBe(1);
        expect(count(html, "reviews-leftover")).toBe(2);
        expect(count(html, "reviews-project-mark")).toBe(2);
        expect(attrs(html, "data-project")).toEqual(["p1", "p2"]);
        expect(deepestButton(html)).toBe(1);
    });

    it("draws no group of leftovers when none is left", () => {
        expect(count(upcomingHtml(Quiet), "reviews-leftovers-toggle")).toBe(0);
    });
});

describe("Notes is one section for every project", () => {
    const withNotes: AllSource[] = [
        sourceOf(Desktop, {
            answer: answer(Desktop, "develop"),
            notes: { repo: "example/p1", notes: [note("a", 10)] },
        }),
        sourceOf(Mobile, { answer: answer(Mobile, "main"), notes: { repo: "example/p2", notes: [note("b", 20)] } }),
        sourceOf(Website, { answer: answer(Website, "develop"), notes: { repo: "example/p3", notes: [] } }),
    ];

    it("lists the notes of every project once, the newest first, each with its project's mark", () => {
        const html = renderToStaticMarkup(
            <AllNotesSection sources={withNotes} blockId="b1" ask={null} marks={Marks} />
        );
        expect(count(html, "reviews-notes")).toBe(1);
        expect(count(html, "reviews-notes-toggle")).toBe(1);
        expect(count(html, "reviews-notes-filter")).toBe(1);
        expect(attrs(html, "data-id")).toEqual(["b", "a"]);
        expect(attrs(html, "data-project")).toEqual(["p2", "p1"]);
        expect(html).not.toContain("reviews-notes-empty");
        expect(deepestButton(html)).toBe(1);
    });

    it("says there is no note once when no project has one", () => {
        const html = renderToStaticMarkup(<AllNotesSection sources={Quiet} blockId="b1" ask={null} marks={Marks} />);
        expect(count(html, "reviews-notes")).toBe(1);
        expect(count(html, "reviews-notes-empty")).toBe(1);
        expect(html).toContain("Keep an AI explanation from a Review view");
        expect(count(html, "reviews-project-mark")).toBe(0);
    });
});

describe("Recently merged is one section for every project", () => {
    const withMerged: AllSource[] = [
        sourceOf(Desktop, { answer: answer(Desktop, "develop", { merged: [merged(10), merged(9)] }) }),
        sourceOf(Mobile, { answer: answer(Mobile, "main", { merged: [merged(3)] }) }),
        sourceOf(Website, { answer: answer(Website, "develop", { merged: [] }) }),
    ];

    function render(sources: AllSource[]): string {
        return renderToStaticMarkup(<AllMergedSection sources={sources} marks={Marks} onShowNotes={() => {}} />);
    }

    it("lists the merged pull requests of every project in one section, each version's group marked with its project", () => {
        const html = render(withMerged);
        expect(count(html, "reviews-merged")).toBe(1);
        expect(count(html, "reviews-merged-toggle")).toBe(1);
        expect(count(html, "reviews-merged-row")).toBe(3);
        expect(count(html, "reviews-merged-group")).toBe(2);
        expect(attrs(html, "data-project")).toEqual(["p1", "p2"]);
        expect(html).not.toContain("reviews-merged-empty");
        expect(deepestButton(html)).toBe(1);
    });

    it("says nothing merged lately once, not once per project", () => {
        const html = render(Quiet);
        expect(count(html, "reviews-merged-empty")).toBe(1);
        expect(html).toContain("No pull request merged in your projects in the last 7 days.");
    });

    it("says when the merged pull requests could not be read, once, and not that none merged", () => {
        const failing = [
            sourceOf(Desktop, { answer: answer(Desktop, "develop", { mergederror: "boom" }) }),
            sourceOf(Mobile, { answer: answer(Mobile, "main", { mergederror: "bang" }) }),
        ];
        const html = render(failing);
        expect(html).toContain("could not be read");
        expect(html.match(/could not be read/g)).toHaveLength(1);
        expect(html).not.toContain("reviews-merged-empty");
    });
});

describe("a project's mark", () => {
    const facts: ProjectMarkFacts = { id: "p2", label: "Mobile", target: "main", place: false };

    function mark(over: Partial<ProjectMarkFacts> = {}): string {
        return renderToStaticMarkup(<ProjectMark facts={{ ...facts, ...over }} onChoose={() => {}} />);
    }

    it("names the project and the branch its pull requests target", () => {
        const html = mark();
        expect(html).toContain(">Mobile<");
        expect(html).toContain("to main");
        expect(html).toContain('title="Show only Mobile · pull requests into main"');
        expect(html).toContain('data-project="p2"');
    });

    it("says no branch when the project has none yet", () => {
        const html = mark({ target: "" });
        expect(html).not.toContain("reviews-project-mark-target");
        expect(html).toContain('title="Show only Mobile"');
    });

    it("shows the workspace's place colour only when the workspace has one", () => {
        expect(mark({ place: true })).toContain("reviews-project-mark-place");
        expect(mark({ place: true })).toContain("bg-[var(--mt-place)]");
        expect(mark({ place: false })).not.toContain("reviews-project-mark-place");
    });

    it("chooses its project and stops the click there, so the card under it keeps its own action", () => {
        const stop = vi.fn();
        const choose = vi.fn();
        chooseProject({ stopPropagation: stop }, "p2", choose);
        expect(choose).toHaveBeenCalledExactlyOnceWith("p2");
        expect(stop).toHaveBeenCalledOnce();
    });
});

describe("the open pull requests of every project", () => {
    const lane = {
        turn: "yours" as const,
        rows: [
            {
                projectId: "p1",
                dir: "/synthetic/desk",
                pr: { number: 4, title: "First" } as never,
                card: undefined as never,
            },
            {
                projectId: "p2",
                dir: "/synthetic/mob",
                pr: { number: 4, title: "Second" } as never,
                card: undefined as never,
            },
        ],
    };
    const facts = (id: string): ProjectMarkFacts => ({
        id,
        label: id === "p1" ? "Desktop" : "Mobile",
        target: id === "p1" ? "develop" : "main",
        place: false,
    });

    it("marks each row with its project, in the lane of its turn, with no button inside a row's own", () => {
        const html = renderToStaticMarkup(
            <AllLane lane={lane} facts={facts} marks={Marks} edges={[]} onOpen={() => {}} />
        );
        expect(count(html, "reviews-all-lane-yours")).toBe(1);
        expect(count(html, "reviews-all-row")).toBe(2);
        expect(attrs(html, "data-project")).toEqual(["p1", "p1", "p2", "p2"]);
        expect(count(html, "reviews-project-mark")).toBe(2);
        expect(html).toContain("to develop");
        expect(html).toContain("to main");
        expect(deepestButton(html)).toBe(1);
        expect(html).not.toContain("reviews-all-tag");
    });

    it("says no pull request is open once, for the whole workspace", () => {
        const html = renderToStaticMarkup(<AllNoneOpenLine hidden={false} />);
        expect(count(html, "reviews-none-open")).toBe(1);
        expect(html).toContain("No open pull request in your projects.");
        expect(renderToStaticMarkup(<AllNoneOpenLine hidden />)).toContain("Nothing of the followed agents is open.");
    });
});

describe("what is wrong with a project", () => {
    it("is one line each at the top, never a block", () => {
        const html = renderToStaticMarkup(
            <AllProblemLines
                marks={Marks}
                problems={[
                    { kind: "nofolder", project: NoFolder },
                    { kind: "unreadable", project: Mobile, note: "GitHub could not be reached" },
                    { kind: "trust", project: Desktop, dir: "/synthetic/desk" },
                ]}
            />
        );
        expect(count(html, "reviews-all-problems")).toBe(1);
        expect(count(html, "reviews-all-problem")).toBe(3);
        expect(attrs(html, "data-kind")).toEqual(["nofolder", "unreadable", "trust"]);
        expect(html).toContain("Library has no folder yet");
        expect(html).toMatch(/data-testid="reviews-all-give-folder"[^>]*>Give it a folder</);
        expect(html).toContain("Mobile");
        expect(html).toContain("GitHub could not be reached");
        expect(html).toContain("A run was refused in Desktop");
        expect(html).toMatch(/data-testid="reviews-all-trust"[^>]*>Approve the commands…</);
        expect(html).not.toContain("reviews-all-project-sections");
        expect(deepestButton(html)).toBe(1);
    });

    it("draws nothing when every project reads", () => {
        expect(renderToStaticMarkup(<AllProblemLines marks={Marks} problems={[]} />)).toBe("");
    });
});

describe("the views stay apart", () => {
    const ViewSource = readFileSync(new URL("./reviews-view.tsx", import.meta.url), "utf8");
    const ProjectsSource = readFileSync(new URL("./reviews-projects.tsx", import.meta.url), "utf8");

    it("draws a project's own view as before, with no mark on its cards", () => {
        expect(ViewSource).toContain("<ProjectTail ");
        expect(ViewSource).toContain("<NoneOpenLine ");
        expect(ViewSource).not.toMatch(/import \{[^}]*\b(UpcomingSection|MergedSection|NotesSection)\b/);
        expect(ViewSource).not.toContain("ProjectMark");
        expect(ViewSource).not.toContain("reviews-all-");
    });

    it("draws All projects without a block per project or the project's own tail", () => {
        expect(ProjectsSource).not.toContain("ProjectSectionsBlock");
        expect(ProjectsSource).not.toContain("ProjectTail");
        expect(ProjectsSource).not.toContain("reviews-all-project-sections");
        expect(ProjectsSource).toMatch(/<AllUpcomingSection\b/);
        expect(ProjectsSource).toMatch(/<AllNotesSection\b/);
        expect(ProjectsSource).toMatch(/<AllMergedSection\b/);
    });

    it("chooses the project of a mark as the chip at the top does, saved on the workspace", () => {
        expect(ProjectsSource).toMatch(
            /onChoose: \(id: string\) => ReviewsProjectFilter\.getInstance\(\)\.choose\(workspaceId, id\)/
        );
    });
});
