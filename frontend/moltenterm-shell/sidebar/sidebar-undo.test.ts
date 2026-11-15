// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/util/platformutil", () => ({ isMacOS: () => true }));

import { globalStore } from "@/app/store/jotaiStore";
import { Toasts } from "../toast-store";
import { showUndoToast, undoFromKey } from "./sidebar-undo";

function stack() {
    return globalStore.get(Toasts.getInstance().stackAtom);
}

function cmdZ(): KeyboardEvent {
    return { key: "z", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false } as KeyboardEvent;
}

// Each test starts with no toast: the ones a test left go as if dismissed, so no count carries over.
beforeEach(() => {
    stack().forEach((toast) => Toasts.getInstance().dismiss(toast.id, "user"));
});

describe("the sidebar's Undo (FR-SHELL-081)", () => {
    it("⌘Z undoes the latest change while its toast shows", async () => {
        const undone: string[] = [];
        showUndoToast("Moved", () => {
            undone.push("moved");
        });
        expect(stack()).toHaveLength(1);
        vi.stubGlobal("document", { activeElement: null });
        expect(undoFromKey(cmdZ())).toBe(true);
        vi.unstubAllGlobals();
        await vi.waitFor(() => expect(undone).toEqual(["moved"]), { timeout: 30000 });
        expect(stack()).toHaveLength(0);
    });

    it("has nothing to undo once its toast is gone", () => {
        const id = showUndoToast("Moved", () => {});
        Toasts.getInstance().dismiss(id, "timeout");
        vi.stubGlobal("document", { activeElement: null });
        expect(undoFromKey(cmdZ())).toBe(false);
        vi.unstubAllGlobals();
    });
});
