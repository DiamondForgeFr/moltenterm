// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "fs";
import { join } from "path";
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
const askCamera = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());
vi.mock("./brainstorm-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        cameraModeAtom: atom("overview"),
        followPulseAtom: atom(0),
        cameraAskAtom: atom(null),
        askCamera,
        breakthroughAtom: atom(null),
        listAtom: atom([]),
        listAskedAtom: atom(0),
        noticeAtom: atom(null),
        forkAtom: atom(null),
        promptAtom: atom(null),
        stateAtom: atom({ allowed: true, open: true, version: 1, cantrash: true } as any),
        refreshList: async () => [],
        end,
        load,
    };
    return { BrainstormModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { t } from "../i18n/i18n";
import { BrainstormPanel, leaveBrainstorm, savedLine } from "./brainstorm-panel";
import { BrainstormPrompts, ForgetConfirm } from "./brainstorm-prompts";
import { BrainstormModel } from "./brainstorm-store";
import { BrainstormView, followBrokk, recentreBrainstorm } from "./brainstorm-view";

const model = BrainstormModel.getInstance() as any;
const Css = readFileSync(join(__dirname, "brainstorm.css"), "utf8");

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
    globalStore.set(model.cameraModeAtom, "overview");
    globalStore.set(model.followPulseAtom, 0);
    globalStore.set(model.listAtom, [
        state.brainstorm,
        folder("forge-notes", "Forge notes", 3),
        { ...folder("family-budget", "A family budget", 2), state: "done" },
        folder("garden", "A garden planner", 1),
    ]);
    globalStore.set(model.stateAtom, { ...state, cantrash: true });
    globalStore.set(model.forkAtom, null);
    globalStore.set(model.promptAtom, null);
    globalStore.set(model.noticeAtom, null);
});

function panel(): string {
    return renderToStaticMarkup(<BrainstormPanel />);
}

// #2285: the layer keeps the line of his thought over the free space; the bottom-right widget and the header's Leave and
// Switch go, since the brainstorm panel of his group holds them (FR-BOSS-010 AC23).
describe("the brainstorm's layer (#2257, #2285)", () => {
    it("draws the stage and the line of his thought, with no widget, and no Leave or switch in the header", () => {
        const html = renderToStaticMarkup(<BrainstormView state={state} shown={true} />);
        expect(html).toContain('data-testid="mock-stage"');
        const header =
            /<div class="mt-bs-header" data-testid="brainstorm-header">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
        expect(header).toContain("Brokk&#x27;s thought");
        // Its only button is #2283's Recentre.
        expect(header.match(/<button/g)).toHaveLength(1);
        expect(header).toContain('data-testid="brainstorm-recentre"');
        for (const gone of ["brainstorm-saved", "brainstorm-leave", "brainstorm-switch", "brainstorm-list"]) {
            expect(html).not.toContain(`data-testid="${gone}"`);
        }
    });
});

describe("the brainstorm panel (FR-BOSS-010 AC9, AC10, AC23, AC25, #2285)", () => {
    it("shows the open brainstorm's title, where it is saved and when, its folder, New idea and Leave", () => {
        const html = panel();
        expect(html).toContain('data-testid="brainstorm-title"');
        expect(html).toContain("A safe video app for children");
        expect(html).toMatch(/data-testid="brainstorm-saved-line"[^>]*>[^]*?Saved automatically · /);
        expect(html).toContain("kids-video/");
        expect(html).toContain('data-testid="brainstorm-new"');
        expect(html).toMatch(/data-testid="brainstorm-leave"[^>]*>[^]*?Leave the brainstorm<\/button>/);
        expect(html).toContain('title="Escape outside a field leaves the brainstorm too"');
        const current = html.slice(0, html.indexOf('class="mt-bsp-others"'));
        for (const action of ["rename", "show", "delete"]) {
            expect(current).toContain(`data-testid="brainstorm-row-${action}"`);
        }
    });

    it("says why a brainstorm is not saved, and names a new idea before its first central idea", () => {
        globalStore.set(model.stateAtom, { ...state, saveerror: "disk full" });
        expect(panel()).toContain("Not saved: the folder could not be written");
        globalStore.set(model.stateAtom, { allowed: true, open: true, version: 1 });
        const html = panel();
        expect(html).toContain("A new idea");
        expect(html).toContain("Saved as soon as the idea is set");
        expect(html).not.toContain('data-testid="brainstorm-saved-folder"');
        expect(savedLine({ allowed: true, open: true, version: 1 }, t, "en").tone).toBe("waiting");
    });

    // AC25: the others, the unfinished ones first and marked, the most recent first; each with Resume and its folder's
    // actions. The open one is not listed again.
    it("lists the other brainstorms, unfinished first, each with Resume, Rename, Show in folder and Delete", () => {
        const html = panel();
        const rows = html.split('data-testid="brainstorm-row"').slice(1);
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => /data-slug="([^"]+)"/.exec(row)?.[1])).toEqual([
            "forge-notes",
            "garden",
            "family-budget",
        ]);
        expect(rows[0]).toMatch(/data-state="open"[^>]*>in progress</);
        expect(rows[2]).toMatch(/data-state="done"[^>]*>finished</);
        for (const row of rows) {
            for (const action of ["load", "rename", "show", "delete"]) {
                expect(row).toContain(`data-testid="brainstorm-row-${action}"`);
            }
        }
        expect(rows[0]).toContain(">Resume</button>");
        expect(html).not.toContain('data-slug="kids-video"');
    });

    it("says when there is no other brainstorm", () => {
        globalStore.set(model.listAtom, [state.brainstorm]);
        expect(panel()).toContain("No other brainstorm yet");
    });

    it("leaves the brainstorm from its button", () => {
        end.mockClear();
        leaveBrainstorm();
        expect(end).toHaveBeenCalledTimes(1);
    });

    // AC11: his fork waits in the panel, with the mockup's two answers.
    it("asks his fork's question: Yes, or No, we stay here", () => {
        globalStore.set(model.forkAtom, { key: "k", title: "Parental control for games", reason: "another product" });
        const html = panel();
        expect(html).toContain("Brokk: “Parental control for games” is another project. Open its own folder?");
        expect(html).toContain('data-testid="brainstorm-fork-yes"');
        expect(html).toContain("No, we stay here");
    });

    it("says what a forget did, and why an action did not go through", () => {
        globalStore.set(model.noticeAtom, { kind: "forgot", title: "A family budget", trashed: true });
        expect(panel()).toContain("“A family budget” is in the trash.");
        globalStore.set(model.noticeAtom, { kind: "failed", failure: "trash" });
        expect(panel()).toContain("The folder could not go to the trash: it stays where it is.");
    });
});

// FR-BOSS-010 AC7a, AC7b (#2283): Recentre and the Follow Brokk chip in the header, after the line of his thought; Leave
// and the switch are in the brainstorm panel (#2285).
describe("the header's camera controls (#2283)", () => {
    const header = () =>
        /<div class="mt-bs-header" data-testid="brainstorm-header">([\s\S]*?)<\/div>/.exec(
            renderToStaticMarkup(<BrainstormView state={state} shown={true} />)
        )?.[1] ?? "";

    it("holds Recentre after his thought's line, with no Follow chip while Brokk holds the camera", () => {
        const html = header();
        expect(html).toMatch(/data-testid="brainstorm-recentre"[^>]*>[^]*?Recentre<\/button>/);
        expect(html.indexOf("mt-bs-header-text")).toBeLessThan(html.indexOf("brainstorm-recentre"));
        expect(html).not.toContain("brainstorm-follow");
        expect(html).toContain("overview");
    });

    it("shows Follow Brokk once the developer holds the camera, and says the view is theirs", () => {
        globalStore.set(model.cameraModeAtom, "free");
        const html = header();
        expect(html).toMatch(/data-testid="brainstorm-follow"[^>]*>[^]*?Follow Brokk<\/button>/);
        expect(html).toContain("your view");
        expect(html.indexOf("brainstorm-recentre")).toBeLessThan(html.indexOf("brainstorm-follow"));
    });

    it("pulses the chip only when asked, once per ask", () => {
        globalStore.set(model.cameraModeAtom, "free");
        expect(header()).toMatch(/class="mt-bs-follow-glow"/);
        globalStore.set(model.followPulseAtom, 1);
        expect(header()).toMatch(/class="mt-bs-follow-glow is-pulsing"/);
    });

    it("asks the stage's scene to recentre or to follow Brokk", () => {
        askCamera.mockClear();
        recentreBrainstorm();
        followBrokk();
        expect(askCamera.mock.calls).toEqual([["recentre"], ["follow"]]);
    });

    // The stage takes the press while the mode is in: it covers his light scrim, which lies under the layer (#2284), so a
    // click on the dim still never ends the brainstorm; a press on a plate is the plate's, and the layer takes none.
    it("lets the stage take the pointer while the mode is in, and only then", () => {
        expect(Css).toMatch(/\.mt-boss-layer:has\(> \.mt-bs-layer\.is-in\) \.mt-brokk-scrim \{[^}]*z-index: -1;/);
        expect(Css).toMatch(/\n\.mt-bs-layer\.is-in \.mt-bs-stage \{[^}]*pointer-events: auto;[^}]*cursor: grab;/);
        expect(Css).toMatch(/\n\.mt-bs-layer\.is-in \.mt-bs-plate \{[^}]*pointer-events: auto;/);
        expect(/\n\.mt-bs-layer \{([^}]*)\}/.exec(Css)?.[1]).toContain("pointer-events: none;");
        expect(/\n\.mt-bs-stage \{([^}]*)\}/.exec(Css)?.[1]).not.toContain("pointer-events");
    });

    it("pulses the chip once, never in a loop, and as a glow alone under reduced motion", () => {
        expect(Css).toMatch(/\n\.mt-bs-follow-glow\.is-pulsing \{\s*animation: mt-bs-follow-pulse \d+ms ease-out 1;/);
        expect(Css).toMatch(/\.prefers-reduced-motion \.mt-bs-follow-glow\.is-pulsing \{\s*animation-name: mt-bs-follow-glow;/);
        const glow = /@keyframes mt-bs-follow-glow \{([\s\S]*?)\n\}/.exec(Css)?.[1] ?? "";
        const sizes = [...glow.matchAll(/box-shadow: ([^;]+);/g)].map((m) => m[1]);
        expect(sizes).toHaveLength(2);
        expect(sizes[0]).toBe(sizes[1]);
    });
});

describe("the questions in his talk window (AC10a to AC10d, #2248)", () => {
    it("offers the recent ones, a new idea and all brainstorms on entry", () => {
        globalStore.set(model.promptAtom, {
            kind: "picker",
            recent: [
                folder("forge-notes", "Forge notes", 3),
                { ...folder("garden", "A garden planner", 1), state: "done" },
            ],
            total: 5,
        });
        const html = renderToStaticMarkup(<BrainstormPrompts name="Brokk" />);
        expect(html).toContain("Where do we start?");
        expect(html.match(/data-testid="brainstorm-picker-resume"/g)).toHaveLength(2);
        expect(html).toContain("Resume “Forge notes”");
        // AC25 (#2285): an unfinished one says so; a finished one does not.
        expect(html.match(/data-testid="brainstorm-picker-open"/g)).toHaveLength(1);
        expect(html).toMatch(/Resume “Forge notes”<span[^>]*data-testid="brainstorm-picker-open">· in progress</);
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
