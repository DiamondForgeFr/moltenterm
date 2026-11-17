// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const nameAtom = atom("Brokk");
    return { BossBubbleModel: { getInstance: () => ({ nameAtom }) } };
});
vi.mock("./brainstorm-project-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        previewAtom: atom(null),
        nameAtom: atom(""),
        parentAtom: atom(""),
        choiceAtom: atom({ kind: "new" }),
        workspacesAtom: atom([]),
        busyAtom: atom(false),
        failureAtom: atom(null),
        foldedAtom: atom(false),
        show: vi.fn(async () => {}),
    };
    return { BrainstormProjectModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { ProjectCard } from "./brainstorm-project";
import { BrainstormProjectModel } from "./brainstorm-project-store";

const model = BrainstormProjectModel.getInstance() as any;

const brief = {
    schema: "projectbrief",
    version: 1,
    id: "b1",
    source: "brokk",
    brainstorm: "id-kids",
    created: 1,
    name: "Safe Kids Videos",
    slug: "safe-kids-videos",
    pitch: "A video app where parents validate every video.",
    problem: "Children's apps play what nobody chose.",
    users: "Parents of children from 3 to 10.",
};

const Dir = "/synthetic/Projects/safe-kids-videos";

const state = (extra: Record<string, unknown> = {}) =>
    ({
        allowed: true,
        open: true,
        version: 3,
        swap: 2,
        brainstorm: {
            id: "id-kids",
            slug: "kids",
            title: "Kids",
            dir: "/synthetic/Brainstorms/kids",
            created: 1,
            updated: 2,
            state: "clear",
            turns: 4,
        },
        brief,
        graph: {
            schema: 1,
            rev: 2,
            centre: "c",
            nodes: [
                { id: "c", kind: "topic", text: "Kids", status: "open" },
                { id: "make-it", kind: "proposal", text: "Make it a project", status: "proposed", action: "project" },
            ],
            links: [],
        },
        ...extra,
    }) as any;

const render = (s: any) => renderToStaticMarkup(<ProjectCard state={s} />);

beforeEach(() => {
    globalStore.set(model.previewAtom, {
        parent: "/synthetic/Projects",
        name: "safe-kids-videos",
        path: Dir,
        docs: "docs/brainstorm.md",
    });
    globalStore.set(model.nameAtom, "");
    globalStore.set(model.choiceAtom, { kind: "new" });
    globalStore.set(model.workspacesAtom, [{ id: "ws-1", name: "Atelier" }]);
    globalStore.set(model.busyAtom, false);
    globalStore.set(model.failureAtom, null);
    globalStore.set(model.foldedAtom, false);
});

// FR-BOSS-010 AC15, AC-2 (#2250): before the click, the card shows exactly what the click makes.
describe("the project card (#2250)", () => {
    it("shows the full path, git, the copy and the workspace before the click", () => {
        const html = render(state());
        expect(html).toContain('data-kind="ready"');
        expect(html).toContain(`data-testid="brainstorm-project-path">${Dir}<`);
        expect(html).toContain("git starts in it: a new repository.");
        expect(html).toContain(
            "A copy of the brainstorm goes to docs/brainstorm.md: never over a file, and nothing is committed."
        );
        expect(html).toContain("A new workspace, “Safe Kids Videos”");
        expect(html).toContain(">Atelier<");
        expect(html).toMatch(/data-testid="brainstorm-project-create"[^>]*>Create safe-kids-videos/);
        expect(html).toContain('value="safe-kids-videos"');
        // The molten call to action, with its wave.
        expect(html).toMatch(/class="molten-btn[^"]*"[^>]*data-testid="brainstorm-project-create"/);
        expect(html).toContain("molten-btn-wave");
    });

    // AC-2, review of #2250: while the preview of what was just typed comes, no path shows and the click waits.
    it("holds the click while the preview comes", () => {
        globalStore.set(model.previewAtom, null);
        const html = render(state());
        expect(html).not.toContain('data-testid="brainstorm-project-path"');
        expect(html).toContain("df-domino-loader");
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="brainstorm-project-create"/);
    });

    // AC15, review of #2250: an existing workspace linked elsewhere has its link replaced, and the card says so.
    it("says when an existing workspace's link is replaced", () => {
        globalStore.set(model.workspacesAtom, [{ id: "ws-1", name: "Atelier", project: "/synthetic/Projects/old" }]);
        globalStore.set(model.choiceAtom, { kind: "existing", id: "ws-1" });
        expect(render(state())).toContain(
            "This workspace is linked to /synthetic/Projects/old: the project replaces that link."
        );
        globalStore.set(model.choiceAtom, { kind: "new" });
        expect(render(state())).not.toContain('data-testid="brainstorm-project-replaces"');
    });

    // Review of #2250: when wavesrv did not answer the click, the card never says nothing was made: it offers to look.
    it("says an unknown result and offers to look in the folder", () => {
        globalStore.set(model.failureAtom, "unknown");
        const html = render(state());
        expect(html).toContain(en.boss.brainstorm.project.refused.unknown);
        expect(html).not.toContain(en.boss.brainstorm.project.refused.failed);
        expect(html).toContain('data-testid="brainstorm-project-check-folder"');
        expect(html).toContain('data-testid="brainstorm-project-retry"');
    });

    it("shows no card for a brief alone, nor for a proposal set aside", () => {
        expect(render(state({ graph: { schema: 1, rev: 1, centre: "c", nodes: [], links: [] } }))).toBe("");
        const aside = state();
        aside.graph.nodes[1].status = "aside";
        expect(render(aside)).toBe("");
    });

    it("says a refusal in one sentence with Try again, and holds the click", () => {
        globalStore.set(model.previewAtom, {
            parent: "/synthetic/Projects",
            name: "safe-kids-videos",
            path: Dir,
            docs: "docs/brainstorm.md",
            refusal: "inrepo",
        });
        const html = render(state());
        expect(html).toContain('data-refusal="inrepo"');
        expect(html).toContain(en.boss.brainstorm.project.refused.inrepo);
        expect(html).toContain('data-testid="brainstorm-project-retry"');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="brainstorm-project-create"/);
    });

    it("refuses a bad name as it is typed", () => {
        globalStore.set(model.nameAtom, "../outside");
        const html = render(state());
        expect(html).toContain('data-refusal="badname"');
        expect(html).toContain('aria-invalid="true"');
    });

    it("asks for the parent folder first when none is chosen", () => {
        globalStore.set(model.previewAtom, {
            parent: "",
            name: "safe-kids-videos",
            docs: "docs/brainstorm.md",
            refusal: "noparent",
        });
        const html = render(state());
        expect(html).toContain('data-testid="brainstorm-project-choose-parent"');
        expect(html).not.toContain('data-testid="brainstorm-project-path"');
    });

    it("draws the dominoes while it works", () => {
        globalStore.set(model.busyAtom, true);
        const html = render(state());
        expect(html).toContain('data-testid="brainstorm-project-working"');
        expect(html).toContain("df-domino-loader");
        expect(html).not.toContain('data-testid="brainstorm-project-create"');
    });

    it("after the click: where it is, Show in folder and Go to the workspace", () => {
        const done = state({
            brainstorm: {
                ...state().brainstorm,
                state: "promoted",
                promotedto: { dir: Dir, workspace: "ws-1", at: 5 },
            },
        });
        const html = render(done);
        expect(html).toContain('data-kind="done"');
        expect(html).toContain(`data-testid="brainstorm-project-dir">${Dir}<`);
        expect(html).toContain("Linked to the workspace “Atelier”.");
        expect(html).toContain('data-testid="brainstorm-project-show"');
        expect(html).toMatch(/data-testid="brainstorm-project-goto"[^>]*>Go to “Atelier”/);
    });

    it("offers to link a project whose workspace is not linked yet", () => {
        const done = state({
            brainstorm: { ...state().brainstorm, state: "promoted", promotedto: { dir: Dir, at: 5 } },
        });
        const html = render(done);
        expect(html).toContain("Its workspace is not linked yet.");
        expect(html).toContain('data-testid="brainstorm-project-link"');
        expect(html).toContain('data-testid="brainstorm-project-workspace"');
    });

    it("waits for his conclusion when he proposed first, and shows nothing before", () => {
        const proposal = {
            id: "make-it",
            kind: "proposal",
            text: "Make it a project",
            status: "proposed",
            action: "project",
        };
        const waiting = state({
            brief: undefined,
            graph: { schema: 1, rev: 1, centre: "c", nodes: [proposal], links: [] },
        });
        expect(render(waiting)).toContain("Brokk proposes a project: it waits for his conclusion.");
        expect(
            render(state({ brief: undefined, graph: { schema: 1, rev: 1, centre: "c", nodes: [], links: [] } }))
        ).toBe("");
    });

    it("folds to its eyebrow", () => {
        globalStore.set(model.foldedAtom, true);
        const html = render(state());
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('data-testid="brainstorm-project-create"');
    });

    // AC14, AC-5: nothing names Geargrim or a hand-off to come, in the card or in its texts.
    it("names no Geargrim and promises nothing to come", () => {
        const texts = JSON.stringify([en.boss.brainstorm.project, fr.boss.brainstorm.project]);
        for (const word of ["Geargrim", "DiamondForge", "coming soon", "bientôt", "valuation", "valorisation"]) {
            expect(texts).not.toContain(word);
            expect(render(state())).not.toContain(word);
        }
        const source = readFileSync(join(__dirname, "brainstorm-project.tsx"), "utf8");
        expect(source).not.toMatch(/t\("[^"]*geargrim/i);
    });
});
