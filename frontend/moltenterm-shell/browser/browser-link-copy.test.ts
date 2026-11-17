// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkCopiedMs, LinkCopy } from "./browser-link-copy";

describe("Copy link of a page panel (FR-SHELL-051, #1544)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("copies the address as the developer sees it, then confirms in place for a moment", async () => {
        vi.useFakeTimers();
        const copy = new LinkCopy();
        const written: string[] = [];
        const url = "https://example.com/a path?q=1&r=%20#frag";
        expect(await copy.copy(url, async (text) => void written.push(text))).toBe(true);
        expect(written).toEqual([url]);
        expect(globalStore.get(copy.copiedAtom)).toBe(true);
        await vi.advanceTimersByTimeAsync(LinkCopiedMs);
        expect(globalStore.get(copy.copiedAtom)).toBe(false);
    });

    it("keeps the confirmation for the last copy when copying twice", async () => {
        vi.useFakeTimers();
        const copy = new LinkCopy();
        const write = async () => {};
        await copy.copy("https://a.test/", write);
        await vi.advanceTimersByTimeAsync(LinkCopiedMs - 1);
        await copy.copy("https://b.test/", write);
        await vi.advanceTimersByTimeAsync(LinkCopiedMs - 1);
        expect(globalStore.get(copy.copiedAtom)).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(globalStore.get(copy.copiedAtom)).toBe(false);
    });

    it("copies nothing for the start page and does not confirm a failed write", async () => {
        const copy = new LinkCopy();
        const write = vi.fn(async () => {});
        expect(await copy.copy("", write)).toBe(false);
        expect(write).not.toHaveBeenCalled();
        expect(await copy.copy("https://a.test/", async () => Promise.reject(new Error("denied")))).toBe(false);
        expect(globalStore.get(copy.copiedAtom)).toBe(false);
    });
});

describe("the header's wiring (#1544)", () => {
    const root = resolve(__dirname, "../../..");
    const view = readFileSync(resolve(root, "frontend/moltenterm-shell/browser/browser-view.tsx"), "utf8");
    const css = readFileSync(resolve(root, "frontend/moltenterm-shell/browser/browser.css"), "utf8");

    // The frame's own markup is tested on rendered output in page-address-frame.test.tsx; this guards the wiring (#2322).
    it("puts the copy button after the address button, in the tab order and in a frame of its own, not over it", () => {
        const address = view.slice(view.indexOf("function PageAddress("), view.indexOf("function BrowserNavBar("));
        const frame = readFileSync(resolve(root, "frontend/moltenterm-shell/browser/page-address-frame.tsx"), "utf8");
        expect(address).toContain("<PageAddressFrame");
        expect(address).toContain('data-testid="browser-address"');
        expect(address).not.toContain("browser-address-copy");
        expect(address).not.toMatch(/\babsolute\b/);
        expect(address).toMatch(/<\/button>\s*<\/PageAddressFrame>/);
        const children = frame.indexOf("{children}");
        expect(children).toBeGreaterThan(0);
        expect(frame.indexOf('data-testid="browser-address-copy"')).toBeGreaterThan(children);
    });

    it("lets the address button shrink and truncate first in a narrow panel", () => {
        const address = view.slice(view.indexOf("function PageAddress("), view.indexOf("function BrowserNavBar("));
        expect(address).toMatch(/className="flex h-6 min-w-0 flex-1 [^"]*"\s+title=/);
        expect(address).toContain('className="min-w-0 truncate font-mono text-11"');
    });

    it("offers Copy link in the header's overflow menu", () => {
        const menu = view.slice(view.indexOf("showOverflowMenu(e:"), view.indexOf("agentSiteMenu(tab: BrowserTab)"));
        expect(menu).toContain('t("browser.tabMenu.copyLink")');
    });

    // Since #1585 the carpet button fades in a panel without focus; only the "pinned" mark stays and moves to close.
    it("moves the pinned mark next to close in a panel without focus", () => {
        expect(css).toMatch(/:not\(\.block-focused\) \.molten-browser-panel-buttons \.mt-pinned-badge \{\s*order: 1/);
        expect(css).not.toMatch(/\.mt-carpet-button[^{]*\{\s*order/);
        expect(css).toMatch(/\.molten-browser-close \{\s*order: 2/);
        expect(view).toContain('className="molten-browser-close"');
    });
});

describe("the 360 chooser's dismissal (#1544)", () => {
    const source = readFileSync(resolve(__dirname, "../view360/view360-places.tsx"), "utf8");

    it("uses the shared floating primitive and the dismissal of the app's other popovers", () => {
        expect(source).toContain("useFloatingInPlace(");
        expect(source).toContain("useDismiss(");
        expect(source).not.toContain('addEventListener("mousedown"');
    });

    it("closes when focus leaves, as a press in the page's webview only moves the focus", () => {
        expect(source).toContain("onBlur");
        expect(source).toContain("relatedTarget");
    });
});
