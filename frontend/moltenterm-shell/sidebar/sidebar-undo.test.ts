// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/util/platformutil", () => ({ isMacOS: () => true }));

import { globalStore } from "@/app/store/jotaiStore";
import { Toasts } from "../toast-store";
import { showCountedUndoToast, undoFromKey } from "./sidebar-undo";

const title = (count: number) => `${count} archived`;

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

describe("successive archives make one counted toast (#2241)", () => {
    it("counts two archives in one toast, and its Undo gives both back, the latest first", async () => {
        const undone: string[] = [];
        showCountedUndoToast("archive", 1, title, () => {
            undone.push("first");
        });
        showCountedUndoToast("archive", 1, title, () => {
            undone.push("second");
        });
        expect(stack()).toHaveLength(1);
        expect(stack()[0].title).toBe("2 archived");
        await stack()[0].actions[0].run();
        expect(undone).toEqual(["second", "first"]);
    });

    it("adds the size of each gesture: one card, then Archive all of three, is four", () => {
        showCountedUndoToast("archive", 1, title, () => {});
        showCountedUndoToast("archive", 3, title, () => {});
        expect(stack().map((t) => t.title)).toEqual(["4 archived"]);
    });

    it("starts a new count once the toast is gone", () => {
        const id = showCountedUndoToast("archive", 2, title, () => {});
        Toasts.getInstance().dismiss(id, "timeout");
        showCountedUndoToast("archive", 1, title, () => {});
        expect(stack().map((t) => t.title)).toEqual(["1 archived"]);
    });

    it("keeps another kind of gesture apart", () => {
        showCountedUndoToast("archive", 1, title, () => {});
        showCountedUndoToast(
            "other",
            1,
            (n) => `${n} other`,
            () => {}
        );
        expect(stack().map((t) => t.title)).toEqual(["1 archived", "1 other"]);
    });

    it("undoes them all with the shortcut too", async () => {
        const undone: number[] = [];
        showCountedUndoToast("archive", 1, title, () => {
            undone.push(1);
        });
        showCountedUndoToast("archive", 1, title, () => {
            undone.push(2);
        });
        vi.stubGlobal("document", { activeElement: null });
        expect(undoFromKey(cmdZ())).toBe(true);
        vi.unstubAllGlobals();
        await vi.waitFor(() => expect(undone).toEqual([2, 1]), { timeout: 30000 });
        expect(stack()).toHaveLength(0);
    });
});
