// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { describe, expect, it, vi } from "vitest";
import { showReopenedPanel } from "./carpet-reopen";

function model(opts: { in360: boolean; laid: boolean }) {
    const revealBlock = vi.fn();
    const focusNode = vi.fn();
    const layoutModel = {
        focusNode,
        getNodeByBlockId: (blockId: string) => (opts.laid && blockId === "b1" ? { id: "n1" } : null),
        moltenView360: opts.in360 ? { layout: { columns: [] }, revealBlock, carpetColumnOf: () => "c1" } : null,
    } as unknown as LayoutModel;
    return { layoutModel, revealBlock, focusNode };
}

describe("a panel reopened on the carpet (FR-SHELL-126-AC4)", () => {
    it("is brought into view and focused once the layout has laid it", () => {
        const { layoutModel, revealBlock, focusNode } = model({ in360: true, laid: true });
        expect(showReopenedPanel(layoutModel, "b1")).toBe("shown");
        expect(revealBlock).toHaveBeenCalledWith("b1");
        expect(focusNode).toHaveBeenCalledWith("n1");
    });

    it("waits for the layout while the panel is not laid yet", () => {
        const { layoutModel, revealBlock, focusNode } = model({ in360: true, laid: false });
        expect(showReopenedPanel(layoutModel, "b1")).toBe("pending");
        expect(revealBlock).not.toHaveBeenCalled();
        expect(focusNode).not.toHaveBeenCalled();
    });

    it("leaves the panel to the layout outside 360 view", () => {
        const { layoutModel, revealBlock, focusNode } = model({ in360: false, laid: true });
        expect(showReopenedPanel(layoutModel, "b1")).toBe("ignored");
        expect(showReopenedPanel(null, "b1")).toBe("ignored");
        expect(revealBlock).not.toHaveBeenCalled();
        expect(focusNode).not.toHaveBeenCalled();
    });
});
