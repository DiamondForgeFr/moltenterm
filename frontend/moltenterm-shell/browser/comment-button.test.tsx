// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Comment button of the web page panel (FR-BRW-017 AC23, #2422): an icon, always shown, at the left of the address
// row; pressed while the mode is on, with the count of pending comments. No DOM here to click it: the markup, and the row's
// source for where it stands.

import { globalStore } from "@/app/store/jotaiStore";
import { setKeyUtilPlatform } from "@/util/keyutil";
import { readFileSync } from "node:fs";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { AnnotateSession } from "./annotate-session";
import { CommentButton, type CommentTab } from "./comment-button";

const Noop = () => {};
const Tab: CommentTab = { id: "tab-1", url: "http://localhost:5173/shop" };

function draw(session: AnnotateSession, tab: CommentTab = Tab): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <CommentButton session={session} tab={tab} onStart={Noop} />
        </Provider>
    );
}

afterEach(() => {
    I18nModel.getInstance().setLanguageSetting("en");
    setKeyUtilPlatform("darwin");
});

describe("the Comment button", () => {
    it("is an icon, a speech bubble with a plus, named Comment, with the shortcut in its tooltip", () => {
        const html = draw(new AnnotateSession());
        expect(html).toContain("lucide-message-square-plus");
        expect(html).toContain('aria-label="Comment"');
        expect(html).toMatch(/title="Comment on this page \([^)]+\)"/);
        expect(html).not.toContain(">Comment<");
        expect(html).toContain('data-testid="browser-annotate-button"');
        expect(html).toContain("cursor-pointer");
    });

    it("names the shortcut with the glyphs of the platform, never a platform", () => {
        expect(draw(new AnnotateSession())).toMatch(/\(⇧⌘A\)|\(Ctrl\+Shift\+A\)/);
        expect(draw(new AnnotateSession())).not.toMatch(/\b(Mac|macOS|Finder|Windows)\b/);
    });

    it("is pressed while the mode is on in its tab, and only then", () => {
        const session = new AnnotateSession();
        expect(draw(session)).toContain('aria-pressed="false"');
        session.start("tab-1", Tab.url);
        expect(draw(session)).toContain('aria-pressed="true"');
        expect(draw(session)).toContain("bg-hover text-primary");
        expect(draw(session, { ...Tab, id: "tab-2" })).toContain('aria-pressed="false"');
    });

    it("carries the number of comments pending in its tab", () => {
        const session = new AnnotateSession();
        session.start("tab-1", Tab.url);
        expect(draw(session)).not.toContain("browser-annotate-count-badge");
        session.setCount("tab-1", 3);
        const html = draw(session);
        expect(html).toContain('data-testid="browser-annotate-count-badge"');
        expect(html).toMatch(/data-testid="browser-annotate-count-badge">3</);
        expect(html).toContain('aria-label="Comment, 3 comments"');
        session.setCount("tab-1", 1);
        expect(draw(session)).toContain('aria-label="Comment, 1 comment"');
        expect(draw(session, { ...Tab, id: "tab-2" })).not.toContain("browser-annotate-count-badge");
    });

    it("is shown on a page that cannot be commented on, dimmed and saying why", () => {
        for (const tab of [
            { ...Tab, url: "about:blank" },
            { ...Tab, url: "file:///etc/hosts" },
            { ...Tab, engine: "firefox" },
        ]) {
            const html = draw(new AnnotateSession(), tab);
            expect(html).toContain("opacity-40");
            expect(html).toContain('aria-disabled="true"');
            expect(html).toContain('title="Comments work on web pages only"');
        }
        expect(draw(new AnnotateSession())).toContain('aria-disabled="false"');
    });

    it("is in French too", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = draw(new AnnotateSession());
        expect(html).toContain('aria-label="Commenter"');
        expect(html).toContain("Commenter cette page (");
    });

    it("draws nothing for no tab", () => {
        expect(draw(new AnnotateSession(), null)).toBe("");
    });
});

// The row's source says where the button stands: no DOM to measure it here (the test instance does).
describe("where the Comment button stands in the address row", () => {
    const source = readFileSync(new URL("./browser-view.tsx", import.meta.url), "utf8");
    const row = source.slice(source.indexOf("function BrowserNavBar"), source.indexOf("// The annotate layers over the panel's pages"));

    it("is right after Forward and before Reload and the address", () => {
        const forward = row.indexOf('"arrow-right"');
        const button = row.indexOf("<CommentButton");
        expect(forward).toBeGreaterThan(0);
        expect(button).toBeGreaterThan(forward);
        expect(button).toBeLessThan(row.indexOf('"rotate-right"'));
        expect(button).toBeLessThan(row.indexOf("<PageAddress"));
        expect(button).toBeLessThan(row.indexOf("<TestContextChip"));
    });

    it("is in no focus-only or folding group, so it never hides with the hover-only controls", () => {
        const at = row.indexOf("<CommentButton");
        const line = row.slice(row.lastIndexOf("\n", at), row.indexOf("\n", at));
        expect(line).not.toMatch(/mt-focus-only|molten-fold/);
        // Nothing wraps it: the element before it is the Forward button's call, whose own classes are Forward's.
        const before = row.slice(row.indexOf('"arrow-right"'), at);
        expect(before).not.toMatch(/<span|<div/);
        // The group of Share, Bookmarks and Open in <browser>, which does hide, no longer holds it.
        const group = row.slice(row.indexOf("<BookmarksButton"), row.indexOf("<BookmarksButton") + 400);
        expect(group).not.toContain("CommentButton");
    });
});
