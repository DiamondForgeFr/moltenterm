// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", () => ({ getApi: () => ({ revealNativePath: vi.fn() }) }));
vi.mock("./brainstorm-stage", () => ({ BrainstormStage: () => <div data-testid="mock-stage" /> }));
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const nameAtom = atom("Brokk");
    return { BossBubbleModel: { getInstance: () => ({ nameAtom, showPanel: vi.fn() }) } };
});
const end = vi.hoisted(() => vi.fn());
const showAll = vi.hoisted(() => vi.fn());
vi.mock("./brainstorm-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        cameraModeAtom: atom("overview"),
        breakthroughAtom: atom(null),
        listAtom: atom([]),
        widgetOpenAtom: atom(false),
        noticeAtom: atom(null),
        forkAtom: atom(null),
        promptAtom: atom(null),
        stateAtom: atom({ allowed: true, open: true, version: 1, cantrash: true }),
        refreshList: async () => [],
        end,
        showAll,
    };
    return { BrainstormModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BrainstormPrompts, ForgetConfirm } from "./brainstorm-prompts";
import { BrainstormModel } from "./brainstorm-store";
import { BrainstormView, leaveBrainstorm, switchBrainstorm } from "./brainstorm-view";

const model = BrainstormModel.getInstance() as any;

const folder = (slug: string, title: string, updated: number) => ({
    id: `id-${slug}`,
    slug,
    title,
    dir: `/synthetic/Brainstorms/${slug}`,
    created: 1,
    updated,
    state: "open",
    turns: 0,
});

const state = {
    allowed: true,
    open: true,
    version: 1,
    swap: 2,
    brainstorm: folder("kids-video", "A safe video app for children", Date.UTC(2026, 10, 11, 10, 30)),
    graph: { rev: 1, nodes: [{ id: "c", kind: "topic", text: "A safe video app", pos: [0, 0, 0] }], links: [] },
} as any;

beforeEach(() => {
    globalStore.set(model.listAtom, [
        state.brainstorm,
        folder("forge-notes", "Forge notes", 3),
        folder("family-budget", "A family budget", 2),
        folder("garden", "A garden planner", 1),
    ]);
    globalStore.set(model.widgetOpenAtom, false);
    globalStore.set(model.forkAtom, null);
    globalStore.set(model.promptAtom, null);
    globalStore.set(model.noticeAtom, null);
});

function widget(html: string): string {
    const start = html.indexOf('data-testid="brainstorm-saved"');
    return start < 0 ? "" : html.slice(start);
}

// #2257: a click on the dim never ends a brainstorm; the header holds the way out, at the free space's top left.
describe("the brainstorm's header (#2257)", () => {
    it("holds a Leave the brainstorm button, before the line of his thought", () => {
        const html = renderToStaticMarkup(<BrainstormView state={state} shown={true} />);
        const header =
            /<div class="mt-bs-header" data-testid="brainstorm-header">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
        expect(header).toMatch(
            /<button type="button" class="mt-bs-leave cursor-pointer" data-testid="brainstorm-leave">/
        );
        expect(header).toContain("Leave the brainstorm");
        expect(header.indexOf("brainstorm-leave")).toBeLessThan(header.indexOf("mt-bs-header-text"));
        expect(html).toContain("Leave the brainstorm with its button above, or Esc outside a field");
    });

    it("ends the brainstorm from the button", () => {
        end.mockClear();
        leaveBrainstorm();
        expect(end).toHaveBeenCalledTimes(1);
    });

    // AC10c (#2248): the header's switch unfolds the widget's list, without leaving the mode.
    it("holds a switch that unfolds the brainstorms", () => {
        const html = renderToStaticMarkup(<BrainstormView state={state} shown={true} />);
        expect(html).toMatch(/data-testid="brainstorm-switch" aria-expanded="false">[^]*?Switch<\/button>/);
        showAll.mockClear();
        end.mockClear();
        switchBrainstorm();
        expect(showAll).toHaveBeenCalledTimes(1);
        expect(end).not.toHaveBeenCalled();
    });
});

describe("the Brainstorms widget (FR-BOSS-010 AC10, #2248)", () => {
    // The mockup's folded plate: Saved and its folder, the other ideas by their folder, Load and New idea.
    it("folded, says where the open one is saved and names two other ideas", () => {
        const html = widget(renderToStaticMarkup(<BrainstormView state={state} shown={true} />));
        expect(html).toContain("Brainstorms");
        expect(html).toContain("kids-video/");
        expect(html).toContain("Other ideas:");
        expect(html.match(/data-testid="brainstorm-other"/g)).toHaveLength(2);
        expect(html).toContain("forge-notes");
        expect(html).not.toContain(">garden<");
        expect(html).toContain('data-testid="brainstorm-new"');
        expect(html).toContain("All (4)");
        expect(html).not.toContain('data-testid="brainstorm-list"');
    });

    // AC-1: every folder with its title, last change and state, and each action; the open one says so.
    it("unfolded, lists every folder with its title, last change, state and actions", () => {
        globalStore.set(model.widgetOpenAtom, true);
        const html = widget(renderToStaticMarkup(<BrainstormView state={state} shown={true} />));
        const rows = html.split('data-testid="brainstorm-row"').slice(1);
        expect(rows).toHaveLength(4);
        expect(rows[0]).toContain("A safe video app for children");
        expect(rows[0]).toContain("· open");
        expect(rows[0]).toContain(">Open<");
        expect(rows[0]).not.toContain('data-testid="brainstorm-row-load"');
        for (const row of rows.slice(1)) {
            for (const action of ["load", "rename", "show", "delete"]) {
                expect(row).toContain(`data-testid="brainstorm-row-${action}"`);
            }
        }
        expect(rows[1]).toContain("Forge notes");
        expect(html).toContain("Fold");
    });

    // AC11: his fork waits in the widget, with the mockup's two answers.
    it("asks his fork's question: Yes, or No, we stay here", () => {
        globalStore.set(model.forkAtom, { key: "k", title: "Parental control for games", reason: "another product" });
        const html = widget(renderToStaticMarkup(<BrainstormView state={state} shown={true} />));
        expect(html).toContain("Brokk: “Parental control for games” is another project. Open its own folder?");
        expect(html).toContain('data-testid="brainstorm-fork-yes"');
        expect(html).toContain("No, we stay here");
    });

    it("says what a forget did, and why an action did not go through", () => {
        globalStore.set(model.noticeAtom, { kind: "forgot", title: "A family budget", trashed: true });
        expect(widget(renderToStaticMarkup(<BrainstormView state={state} shown={true} />))).toContain(
            "“A family budget” is in the trash."
        );
        globalStore.set(model.noticeAtom, { kind: "failed", failure: "trash" });
        expect(widget(renderToStaticMarkup(<BrainstormView state={state} shown={true} />))).toContain(
            "The folder could not go to the trash: it stays where it is."
        );
    });
});

describe("the questions in his talk window (AC10a to AC10d, #2248)", () => {
    it("offers the recent ones, a new idea and all brainstorms on entry", () => {
        globalStore.set(model.promptAtom, {
            kind: "picker",
            recent: [folder("forge-notes", "Forge notes", 3), folder("garden", "A garden planner", 1)],
            total: 5,
        });
        const html = renderToStaticMarkup(<BrainstormPrompts name="Brokk" />);
        expect(html).toContain("Where do we start?");
        expect(html.match(/data-testid="brainstorm-picker-resume"/g)).toHaveLength(2);
        expect(html).toContain("Resume “Forge notes”");
        expect(html).toContain("New idea");
        expect(html).toContain("All brainstorms (5)…");
    });

    it("asks before a near-duplicate, and offers a resume with Resume and Not now", () => {
        globalStore.set(model.promptAtom, {
            kind: "duplicate",
            idea: "forge notes",
            match: folder("forge-notes", "Forge notes", 3),
        });
        let html = renderToStaticMarkup(<BrainstormPrompts name="Brokk" />);
        expect(html).toContain("We already have “Forge notes”: resume it, or start fresh?");
        expect(html).toContain("Start fresh");
        globalStore.set(model.promptAtom, { kind: "resume", match: folder("forge-notes", "Forge notes", 3) });
        html = renderToStaticMarkup(<BrainstormPrompts name="Brokk" />);
        expect(html).toContain("Reopen “Forge notes”?");
        expect(html).toContain('data-testid="brainstorm-prompt-resume"');
        expect(html).toContain("Not now");
    });

    // AC10d: the confirmation shows the title and its last change before anything goes.
    it("shows the title and the last change before a forget", () => {
        const html = renderToStaticMarkup(
            <ForgetConfirm
                summary={folder("family-budget", "A family budget", Date.UTC(2026, 10, 10, 9, 0))}
                busy={false}
                onConfirm={() => {}}
                onCancel={() => {}}
            />
        );
        expect(html).toContain("Forget “A family budget”?");
        expect(html).toMatch(/Last change [^<]*2026[^<]*\. Its folder goes to the trash/);
        expect(html).toContain("Forget it");
        expect(html).toContain("Keep it");
        expect(html).toContain("molten-btn-destructive");
    });

    // Review of #2248: it never promises the trash where the system has none, or before wavesrv said it has one.
    it("says the folder is removed for good where there is no trash", () => {
        const confirm = () =>
            renderToStaticMarkup(
                <ForgetConfirm
                    summary={folder("family-budget", "A family budget", 1)}
                    busy={false}
                    onConfirm={() => {}}
                    onCancel={() => {}}
                />
            );
        for (const known of [{ allowed: true, open: false, version: 1, cantrash: false }, null]) {
            globalStore.set(model.stateAtom, known);
            const html = confirm();
            expect(html).toContain("its folder is removed for good");
            expect(html).not.toContain("goes to the trash");
            expect(html).toContain("Remove it for good");
        }
        globalStore.set(model.stateAtom, { allowed: true, open: true, version: 1, cantrash: true });
    });
});
