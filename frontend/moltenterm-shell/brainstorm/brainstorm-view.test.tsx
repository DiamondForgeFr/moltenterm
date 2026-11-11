// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("./brainstorm-stage", () => ({ BrainstormStage: () => <div data-testid="mock-stage" /> }));
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const nameAtom = atom("Brokk");
    return { BossBubbleModel: { getInstance: () => ({ nameAtom, showPanel: vi.fn() }) } };
});
const end = vi.hoisted(() => vi.fn());
vi.mock("./brainstorm-store", async () => {
    const { atom } = await import("jotai");
    const cameraModeAtom = atom("overview");
    const breakthroughAtom = atom(null);
    return { BrainstormModel: { getInstance: () => ({ cameraModeAtom, breakthroughAtom, end }) } };
});

import { BrainstormView, leaveBrainstorm } from "./brainstorm-view";

const state = {
    allowed: true,
    open: true,
    version: 1,
    graph: { rev: 1, nodes: [{ id: "c", kind: "topic", text: "A safe video app", pos: [0, 0, 0] }], links: [] },
} as any;

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
});
