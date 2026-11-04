// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { CarpetCapture } from "./carpet-captures";
import type { CaptureColumn } from "./carpet-peeks";
import {
    CarpetThumbTracker,
    columnCapturable,
    ColumnPanel,
    columnTag,
    PageHeaderShare,
    panelCapturable,
    panelFactsKey,
    plainPanel,
    tagUrl,
    TrackerDeps,
} from "./carpet-thumb-state";
import type { StoredCarpetThumb } from "./carpet-thumbs";

function page(blockId: string, url: string, patch: Partial<ColumnPanel> = {}): ColumnPanel {
    return { ...plainPanel(blockId), page: true, url, ...patch };
}

// Lets the promises already started run to their end; nothing here waits for time to pass.
async function flush() {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

describe("the thumbnail's tag (a panel and the page it shows)", () => {
    it("names each panel, and a page by its address too", () => {
        expect(columnTag([plainPanel("term1")])).toBe("term1");
        expect(columnTag([page("web1", "https://a.dev/x")])).toBe("web1@https://a.dev/x");
        expect(columnTag([plainPanel("term1"), page("web1", "https://a.dev/x")])).toBe("term1|web1@https://a.dev/x");
    });

    it("moves with the address, and with nothing else of the page", () => {
        const a = columnTag([page("web1", "https://a.dev/x")]);
        expect(columnTag([page("web1", "https://a.dev/y")])).not.toBe(a);
        expect(columnTag([page("web1", "https://a.dev/x", { loading: true, failed: true, crashed: true })])).toBe(a);
        expect(columnTag([page("web2", "https://a.dev/x")])).not.toBe(a);
    });

    it("keeps a very long address short and still distinguishable", () => {
        const long = "https://a.dev/?q=" + "x".repeat(2000);
        expect(tagUrl(long).length).toBeLessThan(400);
        expect(tagUrl(long)).not.toBe(tagUrl(long + "y"));
        expect(tagUrl(long)).toBe(tagUrl(long));
    });
});

describe("when a column may be captured (a good thumbnail is never overwritten by a bad frame)", () => {
    const loaded = page("web1", "https://a.dev/");

    it("lets a loaded page and any other kind of panel through", () => {
        expect(panelCapturable(loaded)).toBe(true);
        expect(panelCapturable(plainPanel("term1"))).toBe(true);
        expect(columnCapturable([plainPanel("term1"), loaded])).toBe(true);
    });

    it.each([
        ["loading", { loading: true }],
        ["failed to load", { failed: true }],
        ["crashed", { crashed: true }],
        ["unloaded or coming back", { unloaded: true }],
        ["not rendered yet", { ready: false }],
        ["handed off to the installed browser", { handedOff: true }],
    ])("refuses a page that is %s", (_name, patch) => {
        expect(panelCapturable({ ...loaded, ...(patch as Partial<ColumnPanel>) })).toBe(false);
    });

    it("refuses a blank page and the empty start page", () => {
        expect(panelCapturable(page("web1", ""))).toBe(false);
        expect(panelCapturable(page("web1", "about:blank"))).toBe(false);
        expect(panelCapturable(page("web1", "about:blank#moltenterm-start"))).toBe(false);
    });

    it("refuses the whole column when one of its panels is not ready, and an empty column", () => {
        expect(columnCapturable([plainPanel("term1"), { ...loaded, loading: true }])).toBe(false);
        expect(columnCapturable([])).toBe(false);
    });

    it("tells a change of state from a mere title or favicon change", () => {
        expect(panelFactsKey(loaded)).toBe(panelFactsKey({ ...loaded }));
        expect(panelFactsKey(loaded)).not.toBe(panelFactsKey({ ...loaded, loading: true }));
        expect(panelFactsKey(loaded)).not.toBe(panelFactsKey({ ...loaded, url: "https://a.dev/next" }));
    });
});

// The tracker over an in-memory carpet: panels read from a table the test edits, a store that answers what it is given.
function setup(columns: CaptureColumn[], stored: Record<string, StoredCarpetThumb & { tag: string }> = {}) {
    const panels = new Map<string, ColumnPanel>();
    for (const c of columns) {
        for (const id of c.blockIds) {
            panels.set(id, plainPanel(id));
        }
    }
    const captures = new Map<string, CarpetCapture>();
    const asked: { key: string; tag: string }[][] = [];
    const listeners = new Map<string, () => void>();
    let wakes = 0;
    let release: () => void = null;
    let hold = false;
    const registered = new Set<string>();
    const deps: TrackerDeps = {
        readPanel: (id) => panels.get(id),
        watchPanel: (id, onChange) => {
            if (!registered.has(id)) {
                return null;
            }
            listeners.set(id, onChange);
            return () => listeners.delete(id);
        },
        readCapture: (columnId) => captures.get(columnId) ?? null,
        writeCapture: (columnId, capture) => {
            if (capture == null) {
                captures.delete(columnId);
            } else {
                captures.set(columnId, capture);
            }
        },
        backend: {
            read: async (items) => {
                asked.push(items);
                if (hold) {
                    await new Promise<void>((resolve) => (release = resolve));
                }
                const rtn: Record<string, StoredCarpetThumb> = {};
                for (const item of items) {
                    const s = stored[item.key];
                    if (s != null && s.tag === item.tag) {
                        rtn[item.key] = s;
                    }
                }
                return rtn;
            },
        },
        wake: () => wakes++,
    };
    const tracker = new CarpetThumbTracker(columns, deps);
    const change = (id: string, patch: Partial<ColumnPanel>) => {
        panels.set(id, { ...panels.get(id), ...patch });
        listeners.get(id)?.();
    };
    return {
        tracker,
        panels,
        captures,
        asked,
        registered,
        change,
        wakes: () => wakes,
        holdStore: () => (hold = true),
        releaseStore: () => release(),
    };
}

const columns: CaptureColumn[] = [
    { columnId: "colA", leafNodeIds: ["nA"], blockIds: ["web1"] },
    { columnId: "colB", leafNodeIds: ["nB", "nC"], blockIds: ["term1", "web2"] },
];

const thumb = (tag: string, at = 5000): StoredCarpetThumb & { tag: string } => ({
    url: "data:image/jpeg;base64,AA==",
    width: 640,
    height: 400,
    at,
    tag,
});

describe("CarpetThumbTracker keeps the in-memory thumbnails true to the page", () => {
    it("fills the columns from the store: an off-screen page needs no visit after a restart", async () => {
        const t = setup(columns, {
            web1: thumb("web1@https://a.dev/", 1234),
            term1: thumb("term1|web2@https://b.dev/"),
        });
        t.panels.set("web1", page("web1", "https://a.dev/"));
        t.panels.set("web2", page("web2", "https://b.dev/"));
        await t.tracker.sync();
        expect(t.captures.get("colA")).toMatchObject({ at: 1234, tag: "web1@https://a.dev/", width: 640 });
        expect(t.captures.get("colB")?.tag).toBe("term1|web2@https://b.dev/");
        expect(t.asked).toHaveLength(1);
        expect(t.asked[0].map((i) => i.key)).toEqual(["web1", "term1"]);
    });

    it("never shows what was taken for another address of the page", async () => {
        const t = setup(columns, { web1: thumb("web1@https://a.dev/old") });
        t.panels.set("web1", page("web1", "https://a.dev/new"));
        await t.tracker.sync();
        expect(t.captures.has("colA")).toBe(false);
    });

    it("empties a column the moment its page changes address, and fills it again if the address comes back", async () => {
        const t = setup(columns, { web1: thumb("web1@https://a.dev/") });
        t.registered.add("web1");
        t.panels.set("web1", page("web1", "https://a.dev/"));
        t.tracker.attach();
        await flush();
        expect(t.captures.get("colA")?.tag).toBe("web1@https://a.dev/");

        t.change("web1", { url: "https://a.dev/next", loading: true });
        expect(t.captures.has("colA")).toBe(false);

        t.change("web1", { url: "https://a.dev/", loading: false });
        await flush();
        expect(t.captures.get("colA")?.tag).toBe("web1@https://a.dev/");
    });

    it("keeps the thumbnail while the page loads, fails, crashes or is unloaded: only its address invalidates it", async () => {
        const t = setup(columns, { web1: thumb("web1@https://a.dev/") });
        t.registered.add("web1");
        t.panels.set("web1", page("web1", "https://a.dev/"));
        t.tracker.attach();
        await flush();
        expect(t.captures.get("colA")?.tag).toBe("web1@https://a.dev/");
        for (const patch of [{ loading: true }, { failed: true }, { crashed: true }, { unloaded: true }]) {
            t.change("web1", { loading: false, failed: false, crashed: false, unloaded: false, ...patch });
            expect(t.captures.get("colA")?.tag).toBe("web1@https://a.dev/");
            expect(t.tracker.inspect("colA").capturable).toBe(false);
        }
        t.change("web1", { loading: false, failed: false, crashed: false, unloaded: false });
        expect(t.tracker.inspect("colA").capturable).toBe(true);
    });

    it("shows the stored thumbnail of an edge page not drawn yet, then loading, unloaded and restored, never the placeholder (#1836)", async () => {
        const t = setup(columns, { web1: thumb("web1@https://a.dev/", 777) });
        // After a restart: the panel's view model is not registered and its webview is not there.
        t.panels.set("web1", page("web1", "https://a.dev/", { ready: false }));
        await t.tracker.sync();
        expect(t.captures.get("colA")?.at).toBe(777);
        t.registered.add("web1");
        t.tracker.attach();
        await flush();
        const states: Partial<ColumnPanel>[] = [
            { ready: true, loading: true },
            { loading: false },
            { unloaded: true },
            { unloaded: false, loading: true },
            { loading: false },
        ];
        for (const patch of states) {
            t.change("web1", patch);
            await flush();
            expect(t.captures.get("colA")?.at).toBe(777);
        }
    });

    it("fills a column the carpet shows empty from the store as soon as its page is unloaded, not only once it is visited (#1836)", async () => {
        const t = setup(columns, { web1: thumb("web1@https://a.dev/", 4242) });
        t.registered.add("web1");
        t.panels.set("web1", page("web1", "https://a.dev/", { unloaded: true, ready: false }));
        t.tracker.attach();
        await flush();
        expect(t.captures.get("colA")?.at).toBe(4242);
        expect(t.tracker.inspect("colA").capturable).toBe(false);
    });

    it("does not ask the store again for a tag it has already asked about", async () => {
        const t = setup(columns);
        await t.tracker.sync();
        await t.tracker.sync();
        expect(t.asked).toHaveLength(1);
    });

    it("lets a capture taken while the store answered win over the stored one", async () => {
        const t = setup(columns, { web1: thumb("web1") });
        t.holdStore();
        const done = t.tracker.sync();
        t.captures.set("colA", { url: "fresh", width: 1, height: 1, at: 9999, tag: "web1" });
        t.releaseStore();
        await done;
        expect(t.captures.get("colA")?.url).toBe("fresh");
    });

    it("drops the stored answer for a page that moved on while the store answered", async () => {
        const t = setup(columns, { web1: thumb("web1@https://a.dev/") });
        t.panels.set("web1", page("web1", "https://a.dev/"));
        t.holdStore();
        const done = t.tracker.sync();
        t.panels.set("web1", page("web1", "https://a.dev/next"));
        t.releaseStore();
        await done;
        expect(t.captures.has("colA")).toBe(false);
    });

    it("wakes the scheduler once per change of state, not for the same state twice", () => {
        const t = setup(columns);
        t.registered.add("web1");
        t.panels.set("web1", page("web1", "https://a.dev/"));
        t.tracker.attach();
        const afterAttach = t.wakes();
        expect(afterAttach).toBeGreaterThan(0);
        t.change("web1", {});
        expect(t.wakes()).toBe(afterAttach);
        t.change("web1", { loading: true });
        expect(t.wakes()).toBe(afterAttach + 1);
        t.change("web1", { loading: false });
        expect(t.wakes()).toBe(afterAttach + 2);
    });

    it("watches a page whose view model registers late, and stops after dispose", () => {
        const t = setup(columns);
        t.panels.set("web1", page("web1", "https://a.dev/", { ready: false }));
        t.tracker.attach();
        expect(t.wakes()).toBe(0);
        t.registered.add("web1");
        t.panels.set("web1", page("web1", "https://a.dev/"));
        t.tracker.attach();
        expect(t.wakes()).toBe(1);
        t.tracker.dispose();
        t.change("web1", { loading: true });
        expect(t.wakes()).toBe(1);
    });

    it("asks the flat-frame check to leave a page's own header out, and only a lone page's", () => {
        const t = setup([
            { columnId: "colA", leafNodeIds: ["nA"], blockIds: ["web1"] },
            { columnId: "colB", leafNodeIds: ["nB", "nC"], blockIds: ["term1", "web2"] },
            { columnId: "colC", leafNodeIds: ["nD"], blockIds: ["term2"] },
        ]);
        t.panels.set("web1", page("web1", "https://a.dev/"));
        t.panels.set("web2", page("web2", "https://b.dev/"));
        expect(t.tracker.flatSkipTop("colA")).toBe(PageHeaderShare);
        expect(t.tracker.flatSkipTop("colB")).toBe(0);
        expect(t.tracker.flatSkipTop("colC")).toBe(0);
    });

    it("keys the store by the column's first panel", () => {
        const t = setup(columns);
        expect(t.tracker.keyOf("colA")).toBe("web1");
        expect(t.tracker.keyOf("colB")).toBe("term1");
        expect(t.tracker.keyOf("unknown")).toBeNull();
    });
});
