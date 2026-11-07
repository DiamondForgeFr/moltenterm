// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GatedPage, LocalPageAsk } from "./local-page-ask";

const model = { allowLocalPage: () => {}, rememberLocalPage: () => {}, declineLocalPage: () => {} };
const Webview = <div data-testid="the-webview" />;

function gate(tab: any, opts: { active?: boolean; remembered?: Record<string, string> } = {}) {
    return renderToStaticMarkup(
        <GatedPage model={model} tab={tab} active={opts.active ?? true} remembered={opts.remembered ?? null}>
            {Webview}
        </GatedPage>
    );
}

describe("a tab holds a local page until the user answers (FR-BRW-014, #1978)", () => {
    it("draws the question and no webview for a file nobody allowed", () => {
        const html = gate({ id: "t", url: "file:///Users/dev/proj/coverage/index.html" });
        expect(html).not.toContain("the-webview");
        expect(html).toContain('data-testid="browser-local-ask"');
        expect(html).toContain("Open a file from this computer?");
        expect(html).toContain("/Users/dev/proj/coverage/index.html");
        expect(html).toContain('data-testid="browser-local-open"');
        expect(html).toContain('data-testid="browser-local-always"');
        expect(html).toContain('data-testid="browser-local-decline"');
    });

    it("draws the question for an inline page, naming its type and beginning, without the always choice", () => {
        const html = gate({ id: "t", url: "data:text/html,%3Cscript%3Ego()%3C%2Fscript%3E" });
        expect(html).not.toContain("the-webview");
        expect(html).toContain("Open an inline page?");
        expect(html).toContain("text/html");
        expect(html).toContain("&lt;script&gt;go()&lt;/script&gt;");
        expect(html).not.toContain('data-testid="browser-local-always"');
    });

    it("holds a hidden tab's page too, drawing nothing", () => {
        const html = gate({ id: "t", url: "file:///tmp/a.html" }, { active: false });
        expect(html).toBe("");
    });

    it("lets the page load once the tab is allowed, the file remembered, or the page is a web page", () => {
        for (const [tab, remembered] of [
            [{ id: "t", url: "file:///tmp/a.html", allowed: true }, null],
            [{ id: "t", url: "file:///tmp/a.html" }, { "/tmp/a.html": "allow" }],
            [{ id: "t", url: "data:text/html,hi", allowed: true }, null],
            [{ id: "t", url: "https://example.com" }, null],
            [{ id: "t", url: "file:///tmp/a.html", engine: "chrome" }, null],
        ] as const) {
            const html = gate(tab, { remembered: remembered as any });
            expect(html, JSON.stringify(tab)).toContain("the-webview");
            expect(html).not.toContain("browser-local-ask");
        }
    });

    it("writes an overriding character in a path as an escape, never as the character", () => {
        const html = renderToStaticMarkup(
            <LocalPageAsk model={model} tab={{ id: "t", url: "file:///tmp/evil%E2%80%AEfdp.html" }} />
        );
        expect(html).toContain("evil\\u202efdp.html");
        expect(html).not.toContain(String.fromCharCode(0x202e));
    });

    it("takes no focus: nothing autofocuses, so a key typed in the terminal cannot answer it", () => {
        const html = gate({ id: "t", url: "file:///tmp/a.html" });
        expect(html).not.toMatch(/autofocus/i);
        expect(html).not.toMatch(/tabindex="-?[1-9]/);
    });
});
