// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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

    it("puts the copy button beside the address chip, in the tab order, not inside the chip's button", () => {
        const chip = view.indexOf('data-testid="browser-address"');
        const copy = view.indexOf('data-testid="browser-address-copy"');
        expect(chip).toBeGreaterThan(0);
        expect(copy).toBeGreaterThan(chip);
        expect(view.slice(chip, copy)).toContain("</button>");
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
