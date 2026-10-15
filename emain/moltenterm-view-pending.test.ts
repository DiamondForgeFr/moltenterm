// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    app: { getPreferredSystemLanguages: () => ["en"] },
    WebContentsView: class {
        handlers = new Map<string, (...args: any[]) => void>();
        openHandler: (details: { url: string }) => { action: string } = null;
        webContents = {
            on: (event: string, fn: (...args: any[]) => void) => this.handlers.set(event, fn),
            setWindowOpenHandler: (fn: (details: { url: string }) => { action: string }) => {
                this.openHandler = fn;
            },
            loadURL: () => Promise.resolve(),
        };
        setBackgroundColor() {}
    },
}));

import { noteLanguageSetting } from "./moltenterm-i18n";
import {
    makePendingPage,
    makePendingPageHtml,
    PendingPageReloadUrl,
    ViewPendingChannel,
    ViewPendingController,
    ViewPendingGraceMs,
    ViewPendingState,
} from "./moltenterm-view-pending";

function makeView() {
    const sent: any[] = [];
    return {
        isDestroyed: false,
        sent,
        webContents: {
            send: (channel: string, state: any) => {
                if (channel === ViewPendingChannel) {
                    sent.push(state);
                }
            },
            isDestroyed: () => false,
        },
    };
}

function makeSurface() {
    const surface = {
        live: makeView() as ReturnType<typeof makeView>,
        pages: [] as (ViewPendingState | "hidden")[],
        liveView: () => surface.live,
        showPage: (state: ViewPendingState) => surface.pages.push(state),
        hidePage: () => surface.pages.push("hidden"),
    };
    return surface;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("ViewPendingController (#450)", () => {
    it("shows nothing for a view ready within the grace", () => {
        const s = makeSurface();
        const c = new ViewPendingController(s);
        const token = c.begin("A", () => {}, Date.now());
        vi.advanceTimersByTime(ViewPendingGraceMs - 1);
        c.end(token);
        vi.advanceTimersByTime(1000);
        expect(s.live.sent).toEqual([]);
    });

    it("shows the pending state on the live view after the grace, counted from the action's start", () => {
        const s = makeSurface();
        const c = new ViewPendingController(s);
        const startedAt = Date.now();
        vi.advanceTimersByTime(40);
        c.begin("A", () => {}, startedAt);
        vi.advanceTimersByTime(19);
        expect(s.live.sent).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(s.live.sent).toEqual([{ phase: "loading", workspaceName: "A" }]);
    });

    it("a newer begin while shown names the new workspace at once; an older end is ignored", () => {
        const s = makeSurface();
        const c = new ViewPendingController(s);
        const first = c.begin("A", () => {}, Date.now());
        vi.advanceTimersByTime(100);
        const second = c.begin("B", () => {}, Date.now());
        expect(s.live.sent).toEqual([
            { phase: "loading", workspaceName: "A" },
            { phase: "loading", workspaceName: "B" },
        ]);
        c.end(first);
        expect(s.live.sent).toHaveLength(2);
        c.end(second);
        expect(s.live.sent[2]).toBeNull();
    });

    it("retrying and failed show at once; settle keeps a failure, Reload keeps it on screen while it reloads", () => {
        const s = makeSurface();
        const c = new ViewPendingController(s);
        const onReload = vi.fn();
        const token = c.begin("A", onReload, Date.now());
        c.setPhase(token, "retrying");
        c.setPhase(token, "failed");
        c.settle();
        expect(s.live.sent).toEqual([
            { phase: "retrying", workspaceName: "A" },
            { phase: "failed", workspaceName: "A" },
        ]);
        c.reload();
        expect(onReload).toHaveBeenCalledOnce();
        expect(s.live.sent[2]).toEqual({ phase: "loading", workspaceName: "A" });
        c.settle();
        expect(s.live.sent[3]).toBeNull();
    });

    it("uses the page when no live view can draw it, and hides the page when one can", () => {
        const s = makeSurface();
        s.live = null;
        const c = new ViewPendingController(s);
        const token = c.begin("A", () => {}, Date.now(), 3000);
        vi.advanceTimersByTime(2999);
        expect(s.pages).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(s.pages).toEqual([{ phase: "loading", workspaceName: "A" }]);
        c.setPhase(token, "failed");
        expect(s.pages[1]).toEqual({ phase: "failed", workspaceName: "A" });
        c.end(token);
        expect(s.pages[2]).toBe("hidden");
    });
});

describe("pending page (#450)", () => {
    it("is static (no script), escapes the name and offers Reload only after a failure", () => {
        const loading = makePendingPageHtml({ phase: "loading", workspaceName: "<b>A</b>" });
        expect(loading).not.toContain("<script");
        expect(loading).toContain("&#60;b&#62;A&#60;/b&#62;");
        expect(loading).toContain('class="line"');
        expect(loading).not.toContain("Reload");
        const failed = makePendingPageHtml({ phase: "failed", workspaceName: "A" });
        expect(failed).toContain('href="moltenterm-pending://reload"');
        expect(failed).toContain("prefers-reduced-motion");
    });

    it("reads in the interface language and never names the machine (#665)", () => {
        try {
            noteLanguageSetting({ "app:language": "fr" });
            const retrying = makePendingPageHtml({ phase: "retrying", workspaceName: "A" });
            expect(retrying).toContain('<html lang="fr">');
            expect(retrying).toContain("Ouverture en cours. Cet ordinateur est occupé.");
            expect(retrying).toContain('aria-label="Ouverture de A"');
            const failed = makePendingPageHtml({ phase: "failed", workspaceName: "A" });
            expect(failed).toContain("A ne s&#39;est pas ouvert");
            expect(failed).toContain(">Recharger</a>");
            expect(failed).not.toMatch(/Reload<|did not open|Opening/);
            const unnamed = makePendingPageHtml({ phase: "failed", workspaceName: "" });
            expect(unnamed).toContain("Cet espace de travail ne s&#39;est pas ouvert");
        } finally {
            noteLanguageSetting({ "app:language": "en" });
        }
        const en = makePendingPageHtml({ phase: "retrying", workspaceName: "A" });
        expect(en).toContain("This computer is busy.");
        expect(en).not.toMatch(/machine/i);
    });

    it("escapes the workspace name inside translated sentences", () => {
        const failed = makePendingPageHtml({ phase: "failed", workspaceName: '<img src=x>"' });
        expect(failed).not.toContain("<img");
        expect(failed).toContain("&#60;img src=x&#62;&#34; did not open");
        const loading = makePendingPageHtml({ phase: "loading", workspaceName: '"><b>' });
        expect(loading).toContain('aria-label="Opening &#34;&#62;&#60;b&#62;"');
    });

    it("never opens a window: a Cmd-click or middle-click on Reload is denied and still reloads (#500)", () => {
        const onReload = vi.fn();
        const page = makePendingPage({ phase: "failed", workspaceName: "A" }, onReload);
        const view = page.view as any;
        expect(view.openHandler).not.toBeNull();
        expect(view.openHandler({ url: PendingPageReloadUrl })).toEqual({ action: "deny" });
        expect(onReload).toHaveBeenCalledOnce();
        expect(view.openHandler({ url: "https://example.com/" })).toEqual({ action: "deny" });
        expect(onReload).toHaveBeenCalledOnce();
        const preventDefault = vi.fn();
        view.handlers.get("will-navigate")({ preventDefault }, PendingPageReloadUrl);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(onReload).toHaveBeenCalledTimes(2);
    });
});
