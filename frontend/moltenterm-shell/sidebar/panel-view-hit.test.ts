// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which zone of the sidebar a dragged panel is over, and where in it (FR-SHELL-080, #2548), read from a small stand-in
// for the page: the sidebar's sections say what they are through attributes, and the pointer is a point on them.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("./view-folders-store", () => ({
    anchorOfFolder: (id: string) => (id === "f1" ? "tab-in-folder" : null),
}));

import { anchorOfItem, panelHitAt, ProjectZoneAttr } from "./panel-view-hit";

type Rect = { left: number; top: number; width: number; height: number };

// An element reduced to what the hit test asks of one: its attributes, its place, its parent and its children.
class FakeEl {
    parent: FakeEl = null;
    children: FakeEl[] = [];
    constructor(
        readonly attrs: Record<string, string>,
        readonly rect: Rect
    ) {}
    add(child: FakeEl): FakeEl {
        child.parent = this;
        this.children.push(child);
        return child;
    }
    getAttribute(name: string): string {
        return this.attrs[name] ?? null;
    }
    getBoundingClientRect(): Rect {
        return this.rect;
    }
    private matches(selector: string): boolean {
        return this.attrs[selector.slice(1, -1)] !== undefined;
    }
    closest(selector: string): FakeEl {
        if (this.matches(selector)) {
            return this;
        }
        return this.parent?.closest(selector) ?? null;
    }
    contains(other: FakeEl): boolean {
        for (let el = other; el != null; el = el.parent) {
            if (el === this) {
                return true;
            }
        }
        return false;
    }
    querySelectorAll(selector: string): FakeEl[] {
        return this.children.flatMap((c) => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]);
    }
    deepest(x: number, y: number): FakeEl {
        const inside = (r: Rect) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
        if (!inside(this.rect)) {
            return null;
        }
        for (const child of this.children) {
            const hit = child.deepest(x, y);
            if (hit != null) {
                return hit;
            }
        }
        return this;
    }
}

const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });
const zone = (name: string, rect: Rect) => new FakeEl({ "data-sb-zone": name }, rect);
const block = (key: string, rect: Rect) => new FakeEl({ "data-sb-key": key }, rect);
const row = (key: string, rect: Rect) => new FakeEl({ "data-item-key": key }, rect);

// A sidebar 260 wide: the top row of three blocks, the tiles (two, side by side), the Views list (a view, a folder, a
// view), and the zone of another project.
function sidebar() {
    const page = new FakeEl({}, box(0, 0, 1000, 800));
    const panels = page.add(new FakeEl({}, box(260, 0, 740, 800)));
    const aside = page.add(new FakeEl({}, box(0, 0, 260, 800)));
    const top = aside.add(zone("top", box(0, 0, 260, 40)));
    for (const [i, key] of ["g1", "g2", "g3"].entries()) {
        top.add(block(key, box(i * 80, 0, 80, 40)));
    }
    const tiles = aside.add(zone("tiles", box(0, 50, 260, 100)));
    tiles.add(block("ta", box(0, 50, 125, 50)));
    tiles.add(block("tb", box(130, 50, 125, 50)));
    tiles.add(block("tc", box(0, 100, 260, 50)));
    const list = aside.add(zone("temporary", box(0, 160, 260, 200)));
    list.add(row("tab:v1", box(0, 200, 260, 30)));
    list.add(row("folder:f1", box(0, 230, 260, 30)));
    list.add(row("tab:v2", box(0, 260, 260, 30)));
    const other = aside.add(new FakeEl({ [ProjectZoneAttr]: "p2" }, box(0, 370, 260, 34)));
    return { page, panels, aside, top, tiles, list, other };
}

let current: ReturnType<typeof sidebar>;

function at(x: number, y: number) {
    return panelHitAt(x, y);
}

beforeAll(() => {
    (globalThis as any).document = {
        elementFromPoint: (x: number, y: number) => current.page.deepest(x, y),
    };
});

afterEach(() => {
    current = null;
});

function useSidebar() {
    current = sidebar();
}

describe("the top row (a view pinned in the context)", () => {
    it("lands before the block under the pointer when it is on its first half", () => {
        useSidebar();
        expect(at(90, 20)).toMatchObject({ zone: "top", key: "g2", after: false, before: "g2" });
    });

    it("lands before the next block when it is on the second half, and at the end past the last", () => {
        useSidebar();
        expect(at(150, 20)).toMatchObject({ zone: "top", key: "g2", after: true, before: "g3" });
        expect(at(230, 20)).toMatchObject({ zone: "top", key: "g3", after: true, before: null });
    });

    it("marks the end of the row when the pointer is on the zone and on no block", () => {
        useSidebar();
        current.top.children.pop();
        expect(at(230, 20)).toMatchObject({ zone: "top", key: "g2", after: true, before: null });
    });
});

describe("the tiles (a view of the workspace)", () => {
    it("lands beside the tile under the pointer: before it on its left half, before the next on its right", () => {
        useSidebar();
        expect(at(20, 70)).toMatchObject({ zone: "tiles", key: "ta", after: false, before: "ta" });
        expect(at(110, 70)).toMatchObject({ zone: "tiles", key: "ta", after: true, before: "tb" });
    });

    it("reads the side from the pointer's height on a tile that fills its row", () => {
        useSidebar();
        const stackedTop = at(100, 110);
        expect(stackedTop).toMatchObject({ zone: "tiles", key: "tc", after: false, stacked: true, before: "tc" });
        const stackedBottom = at(100, 140);
        expect(stackedBottom).toMatchObject({ zone: "tiles", key: "tc", after: true, stacked: true, before: null });
    });
});

describe("the Views list (a view of the project)", () => {
    it("lands before the first row whose middle is below the pointer, naming the view it lands before", () => {
        useSidebar();
        const first = at(100, 205);
        expect(first).toMatchObject({ zone: "temporary", key: "tab:v1", before: "v1" });
        expect(first.folderId).toBeUndefined();
        expect(at(100, 285)).toMatchObject({ zone: "temporary", key: null, before: null });
    });

    it("lands before a folder's first view when it is before the folder's row", () => {
        useSidebar();
        expect(at(100, 232)).toMatchObject({ zone: "temporary", key: "folder:f1", before: "tab-in-folder" });
    });

    it("goes into the folder whose row's middle the pointer is on", () => {
        useSidebar();
        expect(at(100, 245)).toMatchObject({ zone: "temporary", folderId: "f1", key: null, before: null });
    });

    it("names the end of the list above the first row, whatever is on the zone", () => {
        useSidebar();
        expect(at(100, 165)).toMatchObject({ zone: "temporary", key: "tab:v1", before: "v1" });
    });
});

describe("another project's zone", () => {
    it("is that project's, whatever is under it", () => {
        useSidebar();
        expect(at(100, 380)).toEqual({ zone: "project", projectId: "p2" });
    });
});

describe("away from the zones", () => {
    it("is nothing over the panels, so a drag between panels is the layout's alone", () => {
        useSidebar();
        expect(at(600, 300)).toBeNull();
    });

    it("is nothing on the sidebar's own free space", () => {
        useSidebar();
        expect(at(100, 600)).toBeNull();
    });
});

describe("the view a drop before an item lands before", () => {
    it("is a view's own, or a folder's first, or none at the end", () => {
        expect(anchorOfItem("tab:v7")).toBe("v7");
        expect(anchorOfItem("folder:f1")).toBe("tab-in-folder");
        expect(anchorOfItem("folder:gone")).toBeNull();
        expect(anchorOfItem(null)).toBeNull();
    });
});
