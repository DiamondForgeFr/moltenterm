// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    addressRows,
    enterRun,
    fieldContext,
    fieldHint,
    fieldResults,
    FieldRow,
    looksLikeAddress,
    matchScore,
    placePopover,
} from "./top-field-model";

describe("placePopover", () => {
    const inside = (p: { left: number; width: number }, w: number) => p.left >= 0 && p.left + p.width <= w;

    it("sits under the field, wider than the sidebar in a wide window", () => {
        expect(placePopover({ left: 18, bottom: 60, width: 240 }, 1400)).toEqual({ left: 14, top: 64, width: 420 });
    });

    it("stays inside the window while a hidden sidebar is still off its left edge (#1219)", () => {
        const p = placePopover({ left: -270, bottom: 60, width: 240 }, 1400);
        expect(p.left).toBeGreaterThanOrEqual(8);
        expect(inside(p, 1400)).toBe(true);
    });

    it("never overflows a narrow window on either side", () => {
        for (const left of [-500, 0, 300, 700]) {
            expect(inside(placePopover({ left, bottom: 60, width: 240 }, 800), 800)).toBe(true);
            expect(inside(placePopover({ left, bottom: 60, width: 700 }, 600), 600)).toBe(true);
        }
    });
});

function view(name: string, here = true, current = false): FieldRow {
    return {
        id: `view:${name}`,
        group: "view",
        label: name,
        here,
        current,
        run: { kind: "view", tabId: name, workspaceId: here ? "ws1" : "ws2" },
    };
}

function workspace(name: string): FieldRow {
    return {
        id: `workspace:${name}`,
        group: "workspace",
        label: name,
        workspaceName: name,
        run: { kind: "workspace", workspaceId: name },
    };
}

const agent: FieldRow = {
    id: "agent:b1",
    group: "agent",
    label: "Valentin · Claude Code",
    run: { kind: "agent", blockId: "b1" },
};

describe("fieldContext", () => {
    it("shows a page's address", () => {
        expect(fieldContext({ url: "https://github.com/x", viewName: "PR", panelCount: 2 })).toEqual({
            icon: "globe",
            text: "https://github.com/x",
            url: true,
        });
    });

    it("names the panel and its view when the view holds several panels", () => {
        expect(
            fieldContext({ panelLabel: "Valentin", panelIcon: "robot", viewName: "Review", panelCount: 2 }).text
        ).toBe("Valentin · Review");
    });

    it("never repeats a name", () => {
        expect(fieldContext({ panelLabel: "Valentin", viewName: "Valentin", panelCount: 2 }).text).toBe("Valentin");
        expect(fieldContext({ panelLabel: "web", viewName: "web · docs", panelCount: 3 }).text).toBe("web · docs");
        expect(fieldContext({ panelLabel: "zsh", viewName: "Build", panelCount: 1 }).text).toBe("Build");
    });

    it("shows nothing to name without a view", () => {
        expect(fieldContext({}).text).toBe("");
    });
});

describe("looksLikeAddress", () => {
    it("tells an address from words", () => {
        for (const s of ["github.com", "https://x.dev/a b", "localhost:3000", "127.0.0.1:8080/x", "about:blank"]) {
            expect(looksLikeAddress(s.replace(" ", ""))).toBe(true);
        }
        for (const s of ["Notu", "notulia app", "", "readme.m"]) {
            expect(looksLikeAddress(s)).toBe(false);
        }
    });

    it("an address keeps being one with a query, a fragment or an IPv6 host (#1743)", () => {
        for (const s of ["example.com?q=1", "example.com#top", "localhost:3000?x=1", "localhost#a", "[::1]:3000/a"]) {
            expect(looksLikeAddress(s), s).toBe(true);
        }
    });
});

const modeOf = (r: FieldRow) => (r.run.kind === "address" ? r.run.mode : null);

describe("addresses (#1743)", () => {
    it("on a page: Enter goes there, ⌘Enter a new panel, Shift+Enter a new view", () => {
        const rows = addressRows("github.com/a", { onPage: true, pageHost: "docs.dev" }, true);
        expect(rows.map((r) => [r.key, modeOf(r)])).toEqual([
            ["↵", "here"],
            ["⌘↵", "panel"],
            ["⇧↵", "newview"],
        ]);
        expect(rows[0].run).toMatchObject({ url: "https://github.com/a" });
        expect(rows[0].where).toContain("docs.dev");
    });

    it("with no page focused: Enter adds a page panel to the view, Shift+Enter makes a new view", () => {
        const rows = addressRows("localhost:5173", { onPage: false, viewName: "Build" }, true);
        expect(rows.map((r) => [r.key, modeOf(r)])).toEqual([
            ["↵", "panel"],
            ["⇧↵", "newview"],
        ]);
        expect(rows[0].run).toMatchObject({ url: "http://localhost:5173" });
        expect(rows[0].where).toBe("Build");
    });

    it("no plain Enter row ever creates a view", () => {
        for (const onPage of [true, false]) {
            const [first] = addressRows("github.com", { onPage }, true);
            expect(modeOf(first)).not.toBe("newview");
            expect(enterRun(first, {}, true)).toBe(first.run);
        }
    });

    it("on macOS ⌘ opens a new panel and Shift a new view; ⌥ and Ctrl change nothing", () => {
        const [here] = addressRows("github.com", { onPage: true }, true);
        expect(enterRun(here, {}, true)).toMatchObject({ mode: "here" });
        expect(enterRun(here, { meta: true }, true)).toMatchObject({ mode: "panel" });
        expect(enterRun(here, { shift: true }, true)).toMatchObject({ mode: "newview" });
        expect(enterRun(here, { alt: true }, true)).toMatchObject({ mode: "here" });
        expect(enterRun(here, { ctrl: true }, true)).toMatchObject({ mode: "here" });
    });

    it("off macOS Alt opens a new panel and Shift a new view; Ctrl and the Windows key change nothing", () => {
        const [here] = addressRows("github.com", { onPage: true }, false);
        expect(enterRun(here, {}, false)).toMatchObject({ mode: "here" });
        expect(enterRun(here, { alt: true }, false)).toMatchObject({ mode: "panel" });
        expect(enterRun(here, { shift: true }, false)).toMatchObject({ mode: "newview" });
        expect(enterRun(here, { ctrl: true }, false)).toMatchObject({ mode: "here" });
        expect(enterRun(here, { meta: true }, false)).toMatchObject({ mode: "here" });
        expect(enterRun(here, { ctrl: true, shift: false, alt: false }, false)).toBe(here.run);
    });

    it("Shift wins over the new-panel key", () => {
        const [here] = addressRows("github.com", { onPage: true });
        expect(enterRun(here, { meta: true, alt: true, shift: true }, true)).toMatchObject({ mode: "newview" });
        expect(enterRun(here, { meta: true, alt: true, shift: true }, false)).toMatchObject({ mode: "newview" });
    });

    it("the modifiers leave rows that are not addresses as they are", () => {
        expect(enterRun(agent, { meta: true, shift: true, alt: true }, true)).toBe(agent.run);
        expect(enterRun(null, {})).toBeNull();
    });

    it("the hint line says what each key does in the current focus", () => {
        expect(fieldHint(true, true).map((h) => h.keys)).toEqual(["↵", "⌘↵", "⇧↵"]);
        expect(fieldHint(false, true).map((h) => h.keys)).toEqual(["↵", "⇧↵"]);
        expect(fieldHint(true, true).map((h) => h.text)).toEqual(["this page", "new panel", "new view"]);
        expect(fieldHint(false, true).map((h) => h.text)).toEqual(["new panel", "new view"]);
    });

    it("off macOS the hint line and the rows name Alt and Shift, never the macOS glyphs or Ctrl (#1238)", () => {
        const keys = [
            ...fieldHint(true, false).map((h) => h.keys),
            ...fieldHint(false, false).map((h) => h.keys),
            ...addressRows("github.com", { onPage: true }, false).map((r) => r.key),
        ];
        expect(keys.join(" ")).not.toMatch(/[⌥⌘⇧]/);
        expect(keys.join(" ")).not.toMatch(/Ctrl/);
        expect(fieldHint(true, false)[1].keys).toMatch(/^Alt\+/);
        expect(fieldHint(true, false)[2].keys).toMatch(/^Shift\+/);
    });
});

describe("what is typed becomes an address or a search (#1743)", () => {
    const page = { onPage: true, pageHost: "docs.dev", viewName: "Build" };
    const noPage = { onPage: false, viewName: "Build" };

    it("an address is never a search, whatever follows its host", () => {
        for (const text of [
            "example.com",
            "example.com?q=1",
            "example.com#top",
            "example.com/a/b?c=d#e",
            "localhost:3000?x=1",
            "localhost:3000#top",
            "http://localhost:3000",
            "127.0.0.1:8080/x",
            "192.168.1.5",
            "192.168.1.5:8080?x",
            "[::1]:8080",
            "https://example.com/a b",
        ]) {
            const flat = fieldResults(text.replace(" ", ""), [], page, "Molten").flat;
            expect(
                flat.map((r) => r.id),
                text
            ).toEqual(["address:here", "address:panel", "address:newview"]);
            expect(flat.map((r) => r.id).join()).not.toContain("search");
        }
    });

    it("an address goes to the focused page with Enter", () => {
        const [first] = fieldResults("example.com", [], page, "Molten", true).flat;
        expect(first.run).toEqual({ kind: "address", url: "https://example.com", mode: "here" });
    });

    it("words search in the focused page with Enter (nothing matches)", () => {
        const res = fieldResults("some words", [], page, "Molten", true);
        expect(res.flat).toHaveLength(1);
        expect(res.flat[0].id).toBe("search:web");
        expect(res.flat[0].run).toEqual({
            kind: "address",
            url: "https://duckduckgo.com/?q=some%20words",
            mode: "here",
        });
        expect(res.flat[0].key).toBe("↵");
        expect(res.flat[0].where).toContain("docs.dev");
    });

    it("with no page focused, words and addresses go to a new page panel of the view, not a new view", () => {
        const search = fieldResults("zzz qqq", [], noPage, "Molten", true).flat[0];
        expect(search.run).toMatchObject({ kind: "address", mode: "panel" });
        const address = fieldResults("example.com", [], noPage, "Molten", true).flat[0];
        expect(address.run).toMatchObject({ kind: "address", mode: "panel" });
    });

    it("the other keys reach a new panel and a new view from the search row", () => {
        const [search] = fieldResults("some words", [], page, "Molten", true).flat;
        expect(enterRun(search, { meta: true }, true)).toMatchObject({ mode: "panel" });
        expect(enterRun(search, { shift: true }, true)).toMatchObject({ mode: "newview" });
        const [other] = fieldResults("some words", [], noPage, "Molten", true).flat;
        expect(enterRun(other, { meta: true }, true)).toMatchObject({ mode: "panel" });
        expect(enterRun(other, { shift: true }, true)).toMatchObject({ mode: "newview" });
    });

    it("the matches keep their place and the search comes last, without a key", () => {
        const rows = [view("Pilotage"), workspace("Notulia")];
        const res = fieldResults("pil", rows, page, "Molten", true);
        expect(res.flat.map((r) => r.id)).toEqual(["view:Pilotage", "search:web"]);
        expect(res.flat[1].key).toBeUndefined();
        expect(res.flat[1].run).toMatchObject({ mode: "here" });
    });

    it("an empty field offers no search", () => {
        const res = fieldResults("", [view("Pilotage")], page, "Molten");
        expect(res.flat.map((r) => r.id)).not.toContain("search:web");
    });
});

describe("the page the field works on (#1743)", () => {
    it("rows for a page and for no page carry their own target, never both", () => {
        const onPage = fieldResults("github.com", [], { onPage: true, pageHost: "docs.dev" }, "M", true).flat;
        const off = fieldResults("github.com", [], { onPage: false }, "M", true).flat;
        expect(onPage.map(modeOf)).toEqual(["here", "panel", "newview"]);
        expect(off.map(modeOf)).toEqual(["panel", "newview"]);
    });
});

describe("fieldResults", () => {
    const rows = [
        view("Pilotage"),
        view("Build", true, true),
        view("Notes", false),
        agent,
        workspace("Notulia"),
        workspace("MoltenTerm"),
    ];

    it("empty: this workspace's other views, the agents, the workspaces", () => {
        const res = fieldResults("", rows, { onPage: false }, "Molten");
        expect(res.sections.map((s) => s.rows.map((r) => r.id))).toEqual([
            ["view:Pilotage"],
            ["agent:b1"],
            ["workspace:Notulia", "workspace:MoltenTerm"],
        ]);
    });

    it("a workspace whose name starts with the text comes first", () => {
        const withNote: FieldRow[] = [{ ...view("Notulia notes"), id: "view:nn" }, ...rows];
        const res = fieldResults("Notu", withNote, { onPage: false }, "Molten");
        expect(res.flat[0].id).toBe("workspace:Notulia");
    });

    it("an address comes before the matches", () => {
        const res = fieldResults("github.com", rows, { onPage: true }, "Molten");
        expect(res.flat[0].id).toBe("address:here");
    });

    it("words nothing matches search the web, in a panel of the view when no page is focused", () => {
        const res = fieldResults("zzz qqq", rows, { onPage: false }, "Molten");
        expect(res.flat).toHaveLength(1);
        expect(res.flat[0].run).toMatchObject({ kind: "address", mode: "panel" });
    });

    it("matches every word, ignoring case and accents", () => {
        const row: FieldRow = { ...view("Équipe design"), id: "v" };
        expect(matchScore("equipe", row)).toBe(3);
        expect(matchScore("des", row)).toBe(2);
        expect(matchScore("design equ", row)).not.toBeNull();
        expect(matchScore("zz", row)).toBeNull();
    });
});
