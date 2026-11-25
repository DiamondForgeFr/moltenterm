// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What each control of Manage contexts does (#2534). The dialog is called as a function with a few hooks standing in
// for React's (state that survives a render, nothing else), and the tree it returns is walked and its handlers called:
// the project's tests have no DOM. Nothing waits on a clock: a write is awaited by polling what it called, with a
// deadline that only bounds a failing run.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    contexts: [] as any[],
    useState: null as null | ((initial: any) => [any, (value: any) => void]),
    createContext: vi.fn(),
    updateContext: vi.fn(),
    setContextFolder: vi.fn(),
    deleteContext: vi.fn(),
    chooseFolder: vi.fn(),
}));

vi.mock("react", async (original) => ({
    ...(await original<typeof import("react")>()),
    useState: (initial: any) => h.useState(initial),
    useMemo: (compute: () => any) => compute(),
    useId: () => "id",
}));
vi.mock("jotai", async (original) => ({ ...(await original<typeof import("jotai")>()), useAtomValue: () => null }));
vi.mock("@/app/store/global", () => ({ atoms: { workspace: {} } }));
vi.mock("../i18n/i18n", async (original) => {
    const actual = await original<typeof import("../i18n/i18n")>();
    return { ...actual, useT: () => actual.t, useTCount: () => actual.tCount };
});
vi.mock("./context-store", () => ({
    useContexts: () => h.contexts,
    createContext: (...args: any[]) => h.createContext(...args),
    updateContext: (...args: any[]) => h.updateContext(...args),
    setContextFolder: (...args: any[]) => h.setContextFolder(...args),
    deleteContext: (...args: any[]) => h.deleteContext(...args),
}));
vi.mock("../workspace-project-store", () => ({ chooseMoltentermPath: (...args: any[]) => h.chooseFolder(...args) }));
vi.mock("./emblem-picker", () => ({ EmblemPicker: () => null }));
vi.mock("../dialog-frame", () => ({ DialogFrame: () => null }));

import { DialogFrame } from "../dialog-frame";
import { EmblemPicker } from "./emblem-picker";
import { ManageContextsDialog } from "./manage-contexts";
import { ShapeIds } from "./ribbon-shapes";
import { DrawAnotherButton, ShapeGrid } from "./shape-picker";

// A deadline only bounds a failing run, so it is longer than any machine's slowest turn of the event loop, and the
// test's own limit is longer still.
const Deadline = { timeout: 30000 };
vi.setConfig({ testTimeout: 60000 });

const client = { id: "client", name: "Client: SEFERS", description: "Odoo", emblem: "briefcase" };
const other = { id: "other", name: "Other", emblem: "home" };

function findAll(node: any, matches: (element: any) => boolean, found: any[] = []): any[] {
    if (node == null || typeof node !== "object") {
        return found;
    }
    if (Array.isArray(node)) {
        node.forEach((child) => findAll(child, matches, found));
        return found;
    }
    if (node.props == null) {
        return found;
    }
    if (matches(node)) {
        found.push(node);
    }
    Object.values(node.props).forEach((value) => findAll(value, matches, found));
    return found;
}

function textOf(node: any): string {
    if (node == null || typeof node === "boolean") {
        return "";
    }
    if (typeof node === "string" || typeof node === "number") {
        return String(node);
    }
    if (Array.isArray(node)) {
        return node.map(textOf).join("");
    }
    return textOf(node.props?.children);
}

// The dialog on screen: it renders again when a state changed since the last look, as React would.
function mount(entries: any[] = [], onClose: () => void = vi.fn()) {
    const slots: any[] = [];
    let cursor = 0;
    let dirty = true;
    let rendered: any;
    h.useState = (initial) => {
        const at = cursor++;
        if (!(at in slots)) {
            slots[at] = typeof initial === "function" ? initial() : initial;
        }
        return [
            slots[at],
            (value) => {
                const next = typeof value === "function" ? value(slots[at]) : value;
                if (!Object.is(next, slots[at])) {
                    slots[at] = next;
                    dirty = true;
                }
            },
        ];
    };
    const tree = () => {
        if (dirty) {
            cursor = 0;
            dirty = false;
            rendered = ManageContextsDialog({ entries, onClose });
        }
        return rendered;
    };
    const all = (testId: string) => findAll(tree(), (el) => el.props["data-testid"] === testId);
    const one = (testId: string) => {
        const found = all(testId);
        expect(found, `exactly one ${testId}`).toHaveLength(1);
        return found[0];
    };
    const ofType = (type: unknown) => findAll(tree(), (el) => el.type === type)[0];
    const frame = () => ofType(DialogFrame).props;
    const type = (testId: string, value: string) => one(testId).props.onChange({ target: { value } });
    return { tree, all, one, ofType, frame, type, click: (testId: string) => one(testId).props.onClick(), onClose };
}

beforeEach(() => {
    h.contexts = [client, other];
    h.createContext.mockReset().mockResolvedValue("made");
    h.updateContext.mockReset().mockResolvedValue(undefined);
    h.setContextFolder.mockReset().mockResolvedValue(undefined);
    h.deleteContext.mockReset().mockResolvedValue(undefined);
    h.chooseFolder.mockReset().mockResolvedValue(null);
});

describe("Save closes the dialog (#2534)", () => {
    it("writes only what changed, then closes", async () => {
        const m = mount();
        m.type("context-name", "Renamed");
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalledTimes(1), Deadline);
        expect(h.updateContext).toHaveBeenCalledExactlyOnceWith({ id: "client", name: "Renamed" });
        expect(h.createContext).not.toHaveBeenCalled();
        expect(h.updateContext.mock.invocationCallOrder[0]).toBeLessThan(
            (m.onClose as any).mock.invocationCallOrder[0]
        );
    });

    it("offers Save only when something changed, and writes nothing when pressed before", () => {
        const m = mount();
        expect(m.one("context-save").props.disabled).toBe(true);
        m.click("context-save");
        expect(h.updateContext).not.toHaveBeenCalled();
        expect(m.onClose).not.toHaveBeenCalled();
        m.type("context-description", "More");
        expect(m.one("context-save").props.disabled).toBe(false);
    });

    it("creates a context and closes, under the name Create context", async () => {
        const m = mount();
        m.click("context-new");
        expect(textOf(m.one("context-save"))).toBe("Create context");
        m.type("context-name", "Fresh");
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalledTimes(1), Deadline);
        expect(h.createContext).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ name: "Fresh", workspaces: [] })
        );
        expect(ShapeIds).toContain(h.createContext.mock.calls[0][0].shape);
        expect(h.setContextFolder).not.toHaveBeenCalled();
        expect(h.updateContext).not.toHaveBeenCalled();
    });

    it("sets the folder of a context it has just made before it closes", async () => {
        h.chooseFolder.mockResolvedValue("/clients/new");
        const m = mount();
        m.click("context-new");
        m.type("context-name", "Fresh");
        m.click("context-folder-choose");
        await vi.waitFor(() => expect(textOf(m.one("context-folder"))).toBe("/clients/new"), Deadline);
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalledTimes(1), Deadline);
        expect(h.setContextFolder).toHaveBeenCalledExactlyOnceWith("made", "/clients/new");
        expect(h.setContextFolder.mock.invocationCallOrder[0]).toBeLessThan(
            (m.onClose as any).mock.invocationCallOrder[0]
        );
    });

    it("keeps the dialog open with the reason when a save fails, and closes on the retry that works", async () => {
        h.updateContext.mockRejectedValueOnce(new Error("boom"));
        const m = mount();
        m.type("context-name", "Renamed");
        m.click("context-save");
        await vi.waitFor(() => expect(textOf(m.one("context-problem"))).toBe("The change failed: boom"), Deadline);
        expect(m.onClose).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(m.one("context-save").props.disabled).toBe(false), Deadline);
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalledTimes(1), Deadline);
        expect(h.updateContext).toHaveBeenCalledTimes(2);
    });

    it("keeps the dialog open on a context whose folder could not be set, so a second save updates it", async () => {
        h.chooseFolder.mockResolvedValue("/clients/new");
        h.setContextFolder.mockRejectedValueOnce(new Error("not absolute"));
        const m = mount();
        m.click("context-new");
        m.type("context-name", "Fresh");
        m.click("context-folder-choose");
        await vi.waitFor(() => expect(textOf(m.one("context-folder"))).toBe("/clients/new"), Deadline);
        m.click("context-save");
        await vi.waitFor(() => expect(textOf(m.one("context-problem"))).toContain("not absolute"), Deadline);
        expect(m.onClose).not.toHaveBeenCalled();
        expect(h.createContext).toHaveBeenCalledTimes(1);
    });
});

describe("Cancel closes without saving (#2534)", () => {
    it.each([
        ["the Cancel button", (m: ReturnType<typeof mount>) => m.click("context-cancel")],
        ["the cross", (m: ReturnType<typeof mount>) => m.frame().closeButton.onClick()],
        ["Escape", (m: ReturnType<typeof mount>) => m.frame().onEscape()],
        ["a press outside", (m: ReturnType<typeof mount>) => m.frame().onBackdrop()],
    ])("%s drops the draft", (_name, leave) => {
        const m = mount();
        m.type("context-name", "Renamed");
        m.type("context-description", "Another line");
        leave(m);
        expect(m.onClose).toHaveBeenCalledTimes(1);
        expect(h.updateContext).not.toHaveBeenCalled();
        expect(h.createContext).not.toHaveBeenCalled();
        expect(h.setContextFolder).not.toHaveBeenCalled();
        expect(h.deleteContext).not.toHaveBeenCalled();
    });

    it("names the cross for assistive tech and gives it a test handle", () => {
        const m = mount();
        expect(m.frame().closeButton).toMatchObject({ label: "Close", testId: "context-close" });
        expect(textOf(m.one("context-cancel"))).toBe("Cancel");
    });
});

describe("every control of the form still works (#2534)", () => {
    it("lists the contexts, marks the chosen one and switches between them, dropping the edits", () => {
        const m = mount();
        const items = () => m.all("context-list-item");
        expect(items().map((el) => el.props["aria-current"])).toEqual(["true", undefined]);
        expect(items()[0].props.className).toContain("mt-selected-action");
        m.type("context-name", "Renamed");
        items()[1].props.onClick();
        expect(items().map((el) => el.props["aria-current"])).toEqual([undefined, "true"]);
        expect(items()[1].props.className).toContain("mt-selected-action");
        expect(m.one("context-name").props.value).toBe("Other");
        expect(m.one("context-save").props.disabled).toBe(true);
        expect(m.one("context-new").props["aria-current"]).toBeUndefined();
        m.click("context-new");
        expect(m.one("context-new").props["aria-current"]).toBe("true");
        expect(items().map((el) => el.props["aria-current"])).toEqual([undefined, undefined]);
    });

    it("saves the description with its line breaks", async () => {
        const m = mount();
        m.type("context-description", "Odoo\nand billing");
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalled(), Deadline);
        expect(h.updateContext).toHaveBeenCalledExactlyOnceWith({ id: "client", description: "Odoo\nand billing" });
    });

    it("says a name is needed, in the footer, and refuses to save without one", () => {
        const m = mount();
        m.type("context-name", "   ");
        expect(textOf(m.one("context-problem"))).toBe("Give the context a name.");
        expect(m.one("context-save").props.disabled).toBe(true);
        m.click("context-save");
        expect(h.updateContext).not.toHaveBeenCalled();
        expect(m.onClose).not.toHaveBeenCalled();
    });

    it("saves the emblem picked in the picker", async () => {
        const m = mount();
        expect(m.ofType(EmblemPicker).props.value).toBe("briefcase");
        m.ofType(EmblemPicker).props.onChange("globe");
        expect(m.ofType(EmblemPicker).props.value).toBe("globe");
        expect(textOf(m.one("context-emblem-name"))).toBe("globe");
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalled(), Deadline);
        expect(h.updateContext).toHaveBeenCalledExactlyOnceWith({ id: "client", emblem: "globe" });
    });

    it("chooses a folder, forgets it, and saves the change", async () => {
        h.contexts = [{ ...client, folder: "/clients/sefers" }, other];
        h.chooseFolder.mockResolvedValue("/clients/other");
        const m = mount();
        expect(textOf(m.one("context-folder"))).toBe("/clients/sefers");
        m.click("context-folder-choose");
        await vi.waitFor(() => expect(textOf(m.one("context-folder"))).toBe("/clients/other"), Deadline);
        expect(h.chooseFolder).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "folder", defaultPath: "/clients/sefers" })
        );
        m.click("context-folder-remove");
        expect(textOf(m.one("context-folder"))).toBe("No folder");
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalled(), Deadline);
        expect(h.updateContext).toHaveBeenCalledExactlyOnceWith({ id: "client", folder: "" });
    });

    it("picks one of the fifteen ribbon shapes and saves it", async () => {
        const m = mount();
        expect(m.ofType(ShapeGrid).props.value).toBe("v");
        m.ofType(ShapeGrid).props.onChange("moon");
        expect(m.ofType(ShapeGrid).props.value).toBe("moon");
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalled(), Deadline);
        expect(h.updateContext).toHaveBeenCalledExactlyOnceWith({ id: "client", shape: "moon" });
    });

    it("draws another shape: one that is free, and not the one it shows", () => {
        const m = mount();
        const shown = m.ofType(ShapeGrid).props.value;
        m.ofType(DrawAnotherButton).props.onDrawAnother();
        const drawn = m.ofType(ShapeGrid).props.value;
        expect(drawn).not.toBe(shown);
        expect(ShapeIds).toContain(drawn);
        expect(m.one("context-save").props.disabled).toBe(false);
    });

    it("ticks a workspace of another context to move it here, and counts them", async () => {
        const entries = [
            { id: "w1", name: "SASU", color: "#c9d65a", saved: true, contextId: "client" },
            { id: "w2", name: "Échanges", color: "#2FA6A0", saved: true, contextId: "other" },
        ];
        const m = mount(entries);
        const boxes = () => m.all("context-workspace");
        expect(boxes().map((el) => el.props.checked)).toEqual([true, false]);
        expect(textOf(m.one("context-workspaces-count"))).toBe("1 of 2");
        boxes()[1].props.onChange();
        expect(boxes().map((el) => el.props.checked)).toEqual([true, true]);
        expect(textOf(m.one("context-workspaces-count"))).toBe("2 of 2");
        m.click("context-save");
        await vi.waitFor(() => expect(m.onClose).toHaveBeenCalled(), Deadline);
        expect(h.updateContext).toHaveBeenCalledExactlyOnceWith({ id: "client", addworkspaces: ["w2"] });
    });

    it("refuses to empty the only context of its workspaces", () => {
        h.contexts = [client];
        const m = mount([{ id: "w1", name: "SASU", color: "#c9d65a", saved: true, contextId: "client" }]);
        m.all("context-workspace")[0].props.onChange();
        expect(textOf(m.one("context-problem"))).toBe("Make another context first: a workspace has to be in one.");
        expect(m.one("context-save").props.disabled).toBe(true);
    });
});

describe("deleting a context from the Danger zone (#2534)", () => {
    const entries = [{ id: "w1", name: "SASU", color: "#c9d65a", saved: true, contextId: "client" }];
    const confirmation = (m: ReturnType<typeof mount>) =>
        findAll(m.tree(), (el) => el.type?.name === "DeleteContextDialog")[0];

    it("asks where the workspaces go, and moves them there without closing the dialog", async () => {
        const m = mount(entries);
        expect(confirmation(m)).toBeUndefined();
        m.click("context-delete");
        expect(confirmation(m).props).toMatchObject({
            name: "Client: SEFERS",
            count: 1,
            initialTarget: "other",
            targets: [{ id: "other", name: "Other" }],
        });
        confirmation(m).props.onConfirm("other");
        await vi.waitFor(() => expect(h.deleteContext).toHaveBeenCalledExactlyOnceWith("client", "other"), Deadline);
        await vi.waitFor(
            () => expect(m.all("context-list-item").map((el) => el.props["aria-current"])).toEqual([undefined, "true"]),
            Deadline
        );
        expect(confirmation(m)).toBeUndefined();
        expect(m.onClose).not.toHaveBeenCalled();
    });

    it("deletes nothing when the confirmation is cancelled", () => {
        const m = mount(entries);
        m.click("context-delete");
        confirmation(m).props.onCancel();
        expect(confirmation(m)).toBeUndefined();
        expect(h.deleteContext).not.toHaveBeenCalled();
    });

    it("has no Delete for the only context, nor for a context still to be made", () => {
        h.contexts = [client];
        expect(mount().all("context-delete")).toHaveLength(0);
        h.contexts = [client, other];
        const m = mount();
        expect(m.all("context-delete")).toHaveLength(1);
        m.click("context-new");
        expect(m.all("context-delete")).toHaveLength(0);
    });
});
