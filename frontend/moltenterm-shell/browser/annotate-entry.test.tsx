// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Entering comment mode (FR-BRW-017 AC38 to AC41, #2537): the lights round the panel play once, when the mode starts; the
// frame stays in the action colour while the mode is on; under reduced motion there are no lights; the first-use hint
// shows only the first time.

import { globalStore } from "@/app/store/jotaiStore";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { CommentEntryView, entryLights, entryPaths } from "./annotate-entry";
import { AnnotateSession, entryPlays, firstUseHint } from "./annotate-session";
import { CommentToolbar, type CommentToolbarProps } from "./annotate-toolbar";

const Page = "http://localhost:5173/";
const Css = readFileSync(join(__dirname, "annotate-entry.css"), "utf8");
const Noop = () => {};

const toolbarProps: CommentToolbarProps = {
    tool: "freehand",
    paused: false,
    count: 0,
    listOpen: false,
    leaveAsk: false,
    pageAsk: null,
    onTool: Noop,
    onPause: Noop,
    onList: Noop,
    onClear: Noop,
    onReview: Noop,
    onClose: Noop,
    onDiscard: Noop,
    onKeep: Noop,
    onKeepPage: Noop,
    onDiscardPage: Noop,
};

const bar = (change: Partial<CommentToolbarProps> = {}) =>
    renderToStaticMarkup(<CommentToolbar {...toolbarProps} {...change} />);

const view = (on: boolean, lights: boolean) =>
    renderToStaticMarkup(<CommentEntryView on={on} lights={lights} size={{ w: 800, h: 500 }} />);

afterEach(() => I18nModel.getInstance().setLanguageSetting("en"));

describe("the entry plays once, only on entering the mode", () => {
    it("plays for the start that has not played it, and never again for that session", () => {
        const session = new AnnotateSession();
        expect(globalStore.get(session.entryAtom)).toBeNull();
        session.start("tab-1", Page);
        const [open] = session.opens();
        expect(entryPlays(globalStore.get(session.entryAtom), open)).toBe(true);
        session.entryDone(open.nonce);
        // The tab shown again, the layer back from the review: the same session, nothing plays.
        expect(entryPlays(globalStore.get(session.entryAtom), open)).toBe(false);
        // A second press on a tab already in the mode is no entry either.
        session.start("tab-1", Page);
        expect(entryPlays(globalStore.get(session.entryAtom), open)).toBe(false);
        session.close("tab-1");
        session.start("tab-1", Page);
        const [again] = session.opens();
        expect(entryPlays(globalStore.get(session.entryAtom), again)).toBe(true);
    });

    it("ends with its session, and a late end of an older entry leaves the new one", () => {
        const session = new AnnotateSession();
        session.start("tab-1", Page);
        session.close("tab-1");
        expect(globalStore.get(session.entryAtom)).toBeNull();
        session.start("tab-1", Page);
        const [open] = session.opens();
        session.entryDone(open.nonce - 1);
        expect(entryPlays(globalStore.get(session.entryAtom), open)).toBe(true);
    });

    it("draws the lights only while the entry plays, from the middle of the top edge down both sides", () => {
        expect(view(true, true)).toContain('data-testid="browser-annotate-lights"');
        expect(view(true, false)).not.toContain("browser-annotate-lights");
        const [right, left] = entryPaths({ w: 800, h: 500 });
        expect(right).toBe("M 400 1.5 L 798.5 1.5 L 798.5 498.5 L 400 498.5");
        expect(left).toBe("M 400 1.5 L 1.5 1.5 L 1.5 498.5 L 400 498.5");
    });

    it("rings the toolbar and flashes the tool in use only while entering; the halo stays", () => {
        const entering = bar({ entering: true });
        expect(entering).toContain("mt-comment-bar-enter");
        expect(entering).toMatch(/mt-comment-tool-flash[^>]*data-testid="browser-annotate-tool-freehand"/);
        expect(entering.match(/mt-comment-tool-flash/g)).toHaveLength(1);
        const after = bar();
        expect(after).toContain("mt-comment-bar ");
        expect(after).not.toContain("mt-comment-bar-enter");
        expect(after).not.toContain("mt-comment-tool-flash");
        expect(after).not.toContain("mt-comment-hint-enter");
    });

    it("never loops", () => {
        expect(Css).not.toMatch(/infinite/);
    });
});

describe("reduced motion", () => {
    it("skips the lights: the frame alone shows", () => {
        expect(entryLights(true, true)).toBe(false);
        expect(entryLights(true, false)).toBe(true);
        expect(entryLights(false, false)).toBe(false);
        const html = view(true, entryLights(true, true));
        expect(html).toContain('data-testid="browser-annotate-frame"');
        expect(html).not.toContain("browser-annotate-lights");
    });

    it("hides any light the stylesheet would draw, under the system's preference and the app's setting", () => {
        expect(Css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*\.mt-comment-lights\s*{\s*display: none;/);
        expect(Css).toMatch(/\.prefers-reduced-motion \.mt-comment-lights\s*{\s*display: none;/);
    });
});

describe("the frame while the mode is on", () => {
    it("is in the action colour while the mode is on in the shown tab, and gone once it ends", () => {
        expect(view(true, false)).toContain('class="mt-comment-frame"');
        expect(view(false, false)).toBe("");
        expect(Css).toMatch(/\.mt-comment-frame\s*{[^}]*box-shadow: inset 0 0 0 2px var\(--mt-action\)/);
    });
});

describe("the first-use hint", () => {
    it("shows only while the setting does not say it was shown", () => {
        expect(firstUseHint(undefined)).toBe(true);
        expect(firstUseHint(false)).toBe(true);
        expect(firstUseHint(true)).toBe(false);
    });

    it("says what the tools do and how to leave, in place of the tool's hint, in English and French", () => {
        expect(bar({ firstHint: true })).toContain(
            "Draw, frame or click an element to comment on it. Escape to leave."
        );
        expect(bar()).toContain("Draw an outline around what to change.");
        expect(bar()).not.toContain("Escape to leave");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(bar({ firstHint: true })).toContain(
            "Dessinez, encadrez ou cliquez sur un élément pour le commenter. Échap pour sortir."
        );
    });
});
