// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The collapsed rail (FR-SHELL-079, #2384): with the sidebar hidden, the current project's mark and the header's own
// liseré stay at the window's left edge, and nothing else.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider } from "jotai";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { CollapsedRail } from "./collapsed-rail";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

const showContextMenu = vi.fn();
vi.mock("@/app/store/contextmenu", () => ({ ContextMenuModel: { getInstance: () => ({ showContextMenu }) } }));
const openWorkspaceEditor = vi.fn();
vi.mock("../workspace-edit", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../workspace-edit")>()),
    openWorkspaceEditor: (...args: unknown[]) => openWorkspaceEditor(...args),
}));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("window", "win-a")));
    WOS.setObjectValue({ otype: "window", oid: "win-a", version: 1, workspaceid: "ws-a" } as any);
});

const Desktop = { id: "p1", type: "Desktop", dir: "/x/Acme" };
const Website = { id: "p2", type: "Website", dir: "/x/Acme-website" };

// The window shows this workspace now; the same object is read live by the rail.
function showWorkspace(name: string, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("workspace", "ws-a")));
    WOS.setObjectValue({ otype: "workspace", oid: "ws-a", version: 1, name, meta, ...extra } as any);
}

function render(unfolded = false): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <CollapsedRail workspaces={{ entries: [], savedIds: [] }} unfolded={unfolded} />
        </Provider>
    );
}

function openingTag(html: string, testId: string): string {
    const at = html.indexOf(`data-testid="${testId}"`);
    expect(at, testId).toBeGreaterThanOrEqual(0);
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
}

describe("the collapsed rail holds the project's mark and its liseré, nothing else", () => {
    it("draws the header's own liseré before the mark, in a single button", () => {
        showWorkspace("Acme", { "molten:project": "/x/Acme", "molten:projecttype": "Desktop" });
        const html = render();
        expect(html.match(/<button/g)).toHaveLength(1);
        expect(html).toMatch(/<button[^>]*>\s*<span class="mt-sb-place-bar"/);
    });

    it("keeps the window's edge line the docked sidebar draws, and draws no other line", () => {
        showWorkspace("Acme", { "molten:project": "/x/Acme", "molten:projecttype": "Desktop" });
        const html = render();
        expect(html).toMatch(
            /<div class="mt-sb-rail"[^>]*><span class="mt-sb-place-strip" aria-hidden="true"><\/span>/
        );
        expect(html.match(/class="mt-sb-place-(strip|bar)"/g)).toHaveLength(2);
    });

    it("gives the lines no colour of their own: they follow the place colour the workspace sets", () => {
        showWorkspace("Acme", { "molten:project": "/x/Acme", "molten:projecttype": "Desktop" });
        const html = render();
        expect(openingTag(html, "sidebar-collapsed-place-bar")).not.toMatch(/style=/);
        expect(html).not.toMatch(/<span class="mt-sb-place-strip"[^>]*style=/);
    });

    it("stands for a workspace without an icon by the first letter of its name", () => {
        showWorkspace("acme", { "molten:project": "/x/Acme", "molten:projecttype": "Desktop" });
        const html = render();
        expect(openingTag(html, "sidebar-collapsed-mark")).toContain('data-face="initial"');
        expect(html).toContain('<span class="mt-sb-rail-initial" aria-hidden="true">A</span>');
    });

    it("shows each workspace's own mark when the window moves to another", () => {
        showWorkspace("Acme", { "molten:project": "/x/Acme" });
        expect(render()).toContain(">A</span>");
        showWorkspace("Borealis", { "molten:project": "/x/Borealis" });
        const html = render();
        expect(html).toContain(">B</span>");
        expect(html).not.toContain(">A</span>");
    });

    it("shows the project's logo when the workspace keeps one", () => {
        showWorkspace("Acme", {
            "molten:project": "/x/Acme",
            "molten:projecttype": "Desktop",
            "molten:projectlogo": "/x/Acme/logo.svg",
        });
        const html = render();
        expect(openingTag(html, "sidebar-collapsed-mark")).toContain('data-face="logo"');
        expect(html).not.toContain("mt-sb-rail-initial");
    });

    it("shows the workspace's icon for a current project without a logo, among several", () => {
        showWorkspace(
            "Acme",
            {
                "molten:projects": [Desktop, Website],
                "molten:currentproject": "p2",
                "molten:project": "/x/Acme-website",
                "molten:projecttype": "Website",
            },
            { icon: "rocket", color: "#ff7c0d" }
        );
        expect(openingTag(render(), "sidebar-collapsed-mark")).toContain('data-face="workspace"');
    });
});

describe("hovering the mark", () => {
    it("names the workspace and its current project, for the pointer and for a screen reader", () => {
        showWorkspace("Acme", { "molten:project": "/x/Acme", "molten:projecttype": "Desktop" });
        const tag = openingTag(render(), "sidebar-collapsed-mark");
        expect(tag).toContain('title="Acme · Desktop"');
        expect(tag).toContain('aria-label="Acme · Desktop"');
        expect(tag).toContain('aria-haspopup="menu"');
    });

    it("names the project of a workspace with several by the one that is current", () => {
        showWorkspace("Acme", {
            "molten:projects": [Desktop, Website],
            "molten:currentproject": "p2",
            "molten:project": "/x/Acme-website",
            "molten:projecttype": "Website",
        });
        expect(openingTag(render(), "sidebar-collapsed-mark")).toContain('title="Acme · Website"');
    });

    it("names the workspace alone when it has no project", () => {
        showWorkspace("Acme");
        expect(openingTag(render(), "sidebar-collapsed-mark")).toContain('title="Acme"');
    });

    it("says it in both languages with the same placeholders", () => {
        expect(en.sidebar.collapsedMark).toBe("{name} · {project}");
        expect(fr.sidebar.collapsedMark).toBe("{name} · {project}");
    });
});

describe("clicking the mark does what the expanded header does", () => {
    const saved = { id: "ws-a", name: "Acme", saved: true, active: true } as any;

    // The button's click, taken from the element tree of the rail rendered once.
    function click(entries: any[]) {
        let onClick: (e: any) => void = null;
        function Probe() {
            const tree = CollapsedRail({ workspaces: { entries, savedIds: [] }, unfolded: false }) as any;
            const walk = (node: any) => {
                if (node == null || typeof node !== "object") {
                    return;
                }
                if (Array.isArray(node)) {
                    node.forEach(walk);
                    return;
                }
                if (node.type === "button") {
                    onClick = node.props.onClick;
                }
                walk(node.props?.children);
            };
            walk(tree);
            return null;
        }
        renderToStaticMarkup(
            <Provider store={globalStore}>
                <Probe />
            </Provider>
        );
        const anchor = { getBoundingClientRect: () => ({ left: 8, bottom: 30 }) };
        showContextMenu.mockClear();
        openWorkspaceEditor.mockClear();
        onClick({ currentTarget: anchor });
        return anchor;
    }

    it("opens the project menu, under the mark, when the header shows its project chip", () => {
        showWorkspace("Acme", { "molten:project": "/x/Acme", "molten:projecttype": "Desktop" });
        const anchor = click([saved]);
        expect(showContextMenu).toHaveBeenCalledTimes(1);
        const [items, event] = showContextMenu.mock.calls[0];
        expect(items[0]).toEqual({ label: "Projects of Acme", type: "header" });
        expect(items.some((item: any) => item.type === "checkbox" && item.checked && item.label === "Desktop")).toBe(
            true
        );
        expect(event.target).toBe(anchor);
        expect(openWorkspaceEditor).not.toHaveBeenCalled();
    });

    it("opens the workspace menu when the header has no chip", () => {
        showWorkspace("Acme", {});
        click([saved]);
        expect(showContextMenu).toHaveBeenCalledTimes(1);
        const labels = showContextMenu.mock.calls[0][0].map((item: any) => item.label);
        expect(labels[0]).toBe("Edit workspace…");
        expect(labels).not.toContain("Projects of Acme");
        expect(openWorkspaceEditor).not.toHaveBeenCalled();
    });

    it("opens the workspace's sheet, as the header's ⋯ does, while the workspace is not saved yet", () => {
        showWorkspace("Acme", {});
        const anchor = click([{ ...saved, saved: false }]);
        expect(showContextMenu).not.toHaveBeenCalled();
        expect(openWorkspaceEditor).toHaveBeenCalledWith("ws-a", anchor);
    });
});

describe("while the sidebar is unfolded over the rail", () => {
    it("leaves the mark out of sight and out of the tab order", () => {
        showWorkspace("Acme", { "molten:project": "/x/Acme" });
        const tag = openingTag(render(true), "sidebar-collapsed-mark");
        expect(tag).toMatch(/class="[^"]*\bis-unfolded\b/);
        expect(tag).toContain('tabindex="-1"');
        expect(openingTag(render(false), "sidebar-collapsed-mark")).toContain('tabindex="0"');
    });
});

describe("the rail's style", () => {
    const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");
    const sidebar = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
    const src = fs.readFileSync(path.join(__dirname, "collapsed-rail.tsx"), "utf8");

    function rule(selector: string): string {
        const at = css.indexOf(`${selector} {`);
        expect(at, selector).toBeGreaterThanOrEqual(0);
        return css.slice(at, css.indexOf("}", at));
    }

    it("is drawn only while the sidebar is hidden, beside the left-edge zone", () => {
        expect(sidebar).toMatch(
            /\{hidden \? \(\s*<>\s*<div\s+className="mt-sb-edge"[\s\S]*?\/>\s*<Suspense fallback=\{null\}>\s*<CollapsedRail workspaces=\{workspaces\} unfolded=\{peek\} \/>\s*<\/Suspense>\s*<\/>\s*\) : null\}/
        );
    });

    it("opens what the header opens: both read the chip's project type from the same rule", () => {
        expect(sidebar).toContain("const type = headerProjectType(ws);");
        expect(fs.readFileSync(path.join(__dirname, "collapsed-mark-model.ts"), "utf8")).toContain(
            "headerProjectType(ws)"
        );
    });

    it("loads its mark on demand: only a hidden sidebar shows it, and the startup JS budget has no room for it", () => {
        expect(sidebar).toContain('lazy(() => import("./collapsed-rail")');
        expect(sidebar).not.toMatch(/from "\.\/collapsed-rail"/);
        expect(sidebar).not.toMatch(/from "\.\/collapsed-mark-model"/);
    });

    it("takes its room from the content's margin, in the stylesheet: nothing waits for the rail's code", () => {
        expect(rule('.mt-sb[data-hidden="true"] ~ .mt-frame-content')).toContain("margin-left: var(--mt-rail-px)");
        expect(sidebar).toContain('data-hidden={hidden ? "true" : undefined}');
    });

    it("is a column along the window's left edge that takes no pointer, its mark above the left-edge zone", () => {
        const rail = rule(".mt-sb-rail");
        expect(rail).toMatch(/position:\s*absolute/);
        expect(rail).toMatch(/top:\s*0/);
        expect(rail).toMatch(/bottom:\s*0/);
        expect(rail).toMatch(/left:\s*0/);
        expect(rail).toContain("width: var(--mt-rail-px)");
        expect(rail).toContain("pointer-events: none");
        expect(rule(".mt-sb-rail-mark")).toContain("pointer-events: auto");
        const zone = Number(/\.mt-sb-edge \{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
        expect(Number(/z-index:\s*(\d+)/.exec(rail)?.[1])).toBeGreaterThan(zone);
    });

    it("has nothing that moves, so reduced motion has nothing to change", () => {
        for (const selector of [".mt-sb-rail", ".mt-sb-rail-mark", ".mt-sb-rail-initial"]) {
            expect(rule(selector), selector).not.toMatch(/transition|animation/);
        }
    });

    it("uses the header's liseré and tokens, with no line style of its own", () => {
        expect(src).toContain('className="mt-sb-place-bar" data-testid="sidebar-collapsed-place-bar"');
        expect(rule(".mt-sb-rail-initial")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    });

    it("keeps a 24 px target and the app's focus ring", () => {
        const mark = rule(".mt-sb-rail-mark");
        expect(mark).toContain("width: 24px");
        expect(mark).toContain("height: 24px");
        expect(rule(".mt-sb-rail-mark:focus-visible")).toContain("outline: 2px solid var(--mt-focus-ring)");
    });
});
