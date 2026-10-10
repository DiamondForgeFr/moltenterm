// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
    centerOffered,
    DragItem,
    dropAction,
    DropTarget,
    dropZoneAt,
    fileItemFromDragged,
    halfSizes,
    tabDraggedOut,
    targetAllowed,
    zoneGhostRect,
} from "./drop-model";
import { DropSession } from "./drop-session";

const Panel = { left: 100, top: 50, width: 400, height: 200 };
const Term: DropTarget = { blockId: "term", rect: Panel, view: "term" };
const FilePreview: DropTarget = { blockId: "prev", rect: Panel, view: "preview", connection: "" };
const FolderPreview: DropTarget = { ...FilePreview, folder: true };

const TabItem: DragItem = { kind: "tab", tabId: "tabB", name: "api" };
const FileItem: DragItem = {
    kind: "file",
    path: "/work/app/main.go",
    connection: "local",
    name: "main.go",
    isDir: false,
};
const SessionItem: DragItem = { kind: "session", id: "job1", name: "claude" };

describe("drop zones (DS-SHELL-102)", () => {
    it("gives each outer 25 % strip to its side", () => {
        expect(dropZoneAt(490, 150, Panel, false)).toBe("right");
        expect(dropZoneAt(110, 150, Panel, false)).toBe("left");
        expect(dropZoneAt(300, 55, Panel, false)).toBe("up");
        expect(dropZoneAt(300, 245, Panel, false)).toBe("down");
    });

    it("gives the centre only when it is offered", () => {
        expect(dropZoneAt(300, 150, Panel, true)).toBe("center");
        expect(dropZoneAt(300, 150, Panel, false)).toBeNull();
    });

    it("gives a corner to the nearer side, in the panel's proportions", () => {
        // 5 % from the right, 10 % from the bottom.
        expect(dropZoneAt(480, 230, Panel, false)).toBe("right");
        // 10 % from the left, 5 % from the top.
        expect(dropZoneAt(140, 60, Panel, false)).toBe("up");
    });

    it("finds nothing outside the panel", () => {
        expect(dropZoneAt(99, 150, Panel, true)).toBeNull();
        expect(dropZoneAt(300, 251, Panel, true)).toBeNull();
        expect(dropZoneAt(300, 150, null, true)).toBeNull();
    });

    it("does not offer a side the panel is too small to split along", () => {
        const narrow = { left: 0, top: 0, width: 60, height: 400 };
        expect(dropZoneAt(58, 200, narrow, false)).toBeNull();
        expect(dropZoneAt(30, 395, narrow, false)).toBe("down");
    });

    it("draws the ghost on the zone's half, the whole panel for the centre", () => {
        expect(zoneGhostRect("right", 400, 200)).toEqual({ left: 200, top: 0, width: 200, height: 200 });
        expect(zoneGhostRect("left", 400, 200)).toEqual({ left: 0, top: 0, width: 200, height: 200 });
        expect(zoneGhostRect("up", 400, 200)).toEqual({ left: 0, top: 0, width: 400, height: 100 });
        expect(zoneGhostRect("down", 400, 200)).toEqual({ left: 0, top: 100, width: 400, height: 100 });
        expect(zoneGhostRect("center", 400, 200)).toEqual({ left: 0, top: 0, width: 400, height: 200 });
        expect(zoneGhostRect(null, 400, 200)).toBeNull();
    });
});

describe("the centre (open in this panel)", () => {
    it("is offered for a file over a preview showing a file on its connection", () => {
        expect(centerOffered(FileItem, FilePreview)).toBe(true);
        expect(centerOffered(FileItem, { ...FilePreview, connection: "me@box" })).toBe(false);
    });

    it("leaves a folder listing to Wave's own drop (copy into the folder)", () => {
        expect(centerOffered(FileItem, FolderPreview)).toBe(false);
    });

    it("is not offered for a folder, a tab or a session, nor over a terminal", () => {
        expect(centerOffered({ ...FileItem, isDir: true } as DragItem, FilePreview)).toBe(false);
        expect(centerOffered(TabItem, FilePreview)).toBe(false);
        expect(centerOffered(SessionItem, FilePreview)).toBe(false);
        expect(centerOffered(FileItem, Term)).toBe(false);
    });
});

describe("drop to layout action (FR-SHELL-060)", () => {
    it("moves a tab's main panel into the split", () => {
        expect(dropAction(TabItem, "right", Term)).toEqual({
            type: "move-tab-panel",
            tabId: "tabB",
            targetBlockId: "term",
            direction: "right",
        });
    });

    it("opens a file in a preview split, local files without a connection", () => {
        expect(dropAction(FileItem, "down", Term)).toEqual({
            type: "open-file",
            targetBlockId: "term",
            direction: "down",
            blockDef: { meta: { view: "preview", file: "/work/app/main.go" } },
        });
        const remote = { ...FileItem, connection: "me@box" } as DragItem;
        expect(dropAction(remote, "left", Term)).toMatchObject({
            blockDef: { meta: { view: "preview", file: "/work/app/main.go", connection: "me@box" } },
        });
    });

    it("opens a file in the preview under the pointer at the centre", () => {
        expect(dropAction(FileItem, "center", FilePreview)).toEqual({
            type: "open-file-here",
            targetBlockId: "prev",
            path: "/work/app/main.go",
            connection: "local",
        });
    });

    it("resumes a session in a terminal split", () => {
        expect(dropAction(SessionItem, "up", Term)).toEqual({
            type: "resume-session",
            id: "job1",
            targetBlockId: "term",
            direction: "up",
        });
    });

    it("does nothing without a zone, or at a centre the kind does not allow", () => {
        expect(dropAction(TabItem, null, Term)).toBeNull();
        expect(dropAction(TabItem, "center", Term)).toBeNull();
        expect(dropAction(SessionItem, "center", FilePreview)).toBeNull();
        expect(dropAction(FileItem, "center", FolderPreview)).toBeNull();
    });

    it("never drops a tab onto its own panels", () => {
        expect(targetAllowed(TabItem, "tabB")).toBe(false);
        expect(targetAllowed(TabItem, "tabA")).toBe(true);
        expect(targetAllowed(FileItem, "tabA")).toBe(true);
    });
});

describe("drag sources", () => {
    it("reads Wave's file browser rows", () => {
        expect(fileItemFromDragged({ uri: "wsh://local//work/app/main.go", relName: "main.go", isDir: false })).toEqual(
            {
                kind: "file",
                path: "/work/app/main.go",
                connection: "local",
                name: "main.go",
                isDir: false,
            }
        );
        expect(
            fileItemFromDragged({ uri: "wsh://me@box/~/notes.md", relName: "notes.md", isDir: false })
        ).toMatchObject({ path: "~/notes.md", connection: "me@box" });
        expect(fileItemFromDragged({ uri: "file:///x", relName: "x", isDir: false })).toBeNull();
        expect(fileItemFromDragged({ uri: "wsh://local/", relName: "", isDir: true })).toBeNull();
    });

    it("hands a tab over once it is dragged below the strip", () => {
        expect(tabDraggedOut(40, 36)).toBe(false);
        expect(tabDraggedOut(49, 36)).toBe(true);
    });

    it("splits a backend-laid pane in half of the target", () => {
        expect(halfSizes(20)).toEqual({ target: 10, added: 10 });
        expect(halfSizes(undefined)).toEqual({ target: 5, added: 5 });
    });
});

function makeSession(activeTabId = "tabA") {
    const perform = vi.fn(async () => {});
    const session = new DropSession({
        hitTest: (x, y) => (x >= Panel.left && x <= Panel.left + Panel.width && y >= Panel.top ? Term : null),
        activeTabId: () => activeTabId,
        perform,
    });
    return { session, perform };
}

describe("the drag session", () => {
    it("follows the pointer and drops on the zone under it", () => {
        const { session, perform } = makeSession();
        session.begin(TabItem, 300, 150);
        expect(session.state.zone).toBeNull();
        expect(session.move(490, 150)).toBe("right");
        expect(session.state.target.blockId).toBe("term");
        const action = session.drop();
        expect(action).toMatchObject({ type: "move-tab-panel", direction: "right" });
        expect(perform).toHaveBeenCalledWith(action);
        expect(session.active()).toBe(false);
    });

    it("cancels on Escape without any change (FR-SHELL-060-AC3)", () => {
        const { session, perform } = makeSession();
        const seen: unknown[] = [];
        session.subscribe((s) => seen.push(s));
        session.begin(SessionItem, 490, 150);
        expect(session.state.zone).toBe("right");
        expect(session.handleKey("a")).toBe(false);
        expect(session.handleKey("Escape")).toBe(true);
        expect(session.active()).toBe(false);
        expect(seen[seen.length - 1]).toBeNull();
        expect(session.drop(490, 150)).toBeNull();
        expect(perform).not.toHaveBeenCalled();
        expect(session.handleKey("Escape")).toBe(false);
    });

    it("drops nothing in the centre of a terminal or outside the panels", () => {
        const { session, perform } = makeSession();
        session.begin(FileItem, 300, 150);
        expect(session.drop()).toBeNull();
        session.begin(FileItem);
        expect(session.drop(10, 10)).toBeNull();
        expect(perform).not.toHaveBeenCalled();
    });

    it("offers no zone to a tab over its own panels", () => {
        const { session } = makeSession("tabB");
        session.begin(TabItem, 490, 150);
        expect(session.state.target).toBeNull();
        expect(session.state.zone).toBeNull();
    });
});
