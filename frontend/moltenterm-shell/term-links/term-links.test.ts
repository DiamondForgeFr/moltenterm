// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedTermLinkUri, makeTermLinkCallbacks } from "./term-links";

const TermWrapSource = readFileSync(join(__dirname, "../../app/view/term/termwrap.ts"), "utf8");

function mouse(mods: { metaKey?: boolean; ctrlKey?: boolean } = {}): MouseEvent {
    return {
        metaKey: mods.metaKey ?? false,
        ctrlKey: mods.ctrlKey ?? false,
        clientX: 12,
        clientY: 34,
        preventDefault: vi.fn(),
    } as unknown as MouseEvent;
}

function setup(platform: string) {
    const open = vi.fn();
    const hover = vi.fn();
    const leave = vi.fn();
    return { open, hover, leave, callbacks: makeTermLinkCallbacks({ platform, open, hover, leave }) };
}

describe("terminal links (#2507)", () => {
    const confirmSpy = vi.fn(() => true);
    const alertSpy = vi.fn();

    beforeEach(() => {
        vi.stubGlobal("confirm", confirmSpy);
        vi.stubGlobal("alert", alertSpy);
        confirmSpy.mockClear();
        alertSpy.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("opens an OSC 8 link on Cmd-click on macOS, without a native dialog", () => {
        const { open, callbacks } = setup("darwin");
        const e = mouse({ metaKey: true });
        callbacks.activate(e, "https://github.com");
        expect(open).toHaveBeenCalledWith("https://github.com");
        expect(e.preventDefault).toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it("opens on Ctrl-click elsewhere, and ignores Cmd there", () => {
        const { open, callbacks } = setup("linux");
        callbacks.activate(mouse({ metaKey: true }), "https://github.com");
        expect(open).not.toHaveBeenCalled();
        callbacks.activate(mouse({ ctrlKey: true }), "https://github.com");
        expect(open).toHaveBeenCalledWith("https://github.com");
    });

    it("does nothing on a plain click, and asks nothing", () => {
        const { open, callbacks } = setup("darwin");
        callbacks.activate(mouse(), "https://github.com");
        callbacks.activate(mouse({ ctrlKey: true }), "https://github.com");
        expect(open).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it("opens only http and https links", () => {
        const { open, callbacks } = setup("darwin");
        for (const uri of ["file:///etc/passwd", "javascript:alert(1)", "ssh://host", "vscode://x", "not a url", ""]) {
            callbacks.activate(mouse({ metaKey: true }), uri);
        }
        expect(open).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(isAllowedTermLinkUri("http://localhost:3000/x")).toBe(true);
        expect(isAllowedTermLinkUri("HTTPS://GITHUB.COM")).toBe(true);
        expect(callbacks.allowNonHttpProtocols).toBe(false);
    });

    it("shows the real URL on hover, and clears it on leave", () => {
        const { hover, leave, callbacks } = setup("darwin");
        callbacks.hover(mouse(), "https://github.com/DiamondForgeFr");
        expect(hover).toHaveBeenCalledWith("https://github.com/DiamondForgeFr", 12, 34);
        callbacks.leave();
        expect(leave).toHaveBeenCalled();
    });

    it("gives no hover preview to a refused scheme", () => {
        const { hover, callbacks } = setup("darwin");
        callbacks.hover(mouse(), "file:///etc/passwd");
        expect(hover).not.toHaveBeenCalled();
    });

    it("TermWrap hands the same callbacks to the terminal's linkHandler and to WebLinksAddon", () => {
        expect(TermWrapSource).toMatch(/new Terminal\(\{[^}]*linkHandler: linkCallbacks/);
        expect(TermWrapSource).toMatch(
            /new WebLinksAddon\(linkCallbacks\.activate, \{ hover: linkCallbacks\.hover, leave: linkCallbacks\.leave \}\)/
        );
    });
});
