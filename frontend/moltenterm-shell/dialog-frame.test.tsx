// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { DialogFrame } from "./dialog-frame";

beforeAll(() => {
    vi.stubGlobal("document", { body: {} });
});

function frame(props: Partial<React.ComponentProps<typeof DialogFrame>> = {}) {
    return renderToStaticMarkup(
        <DialogFrame role="test-dialog" title="A question" buttons={<button type="button">OK</button>} {...props}>
            <p>Body</p>
        </DialogFrame>
    );
}

describe("DialogFrame's turning light (#890)", () => {
    it("lights every dialog by default, on a positioned, low-cornered frame", () => {
        const html = frame();
        expect(html).toMatch(/<span class="df-glow" data-on=""/);
        expect(html).toMatch(/role="dialog"[^>]*class="[^"]*\brelative\b[^"]*\brounded-4\b/);
    });

    it("keeps the light on a suite frame, which only adds room for its blocks", () => {
        const html = frame({ suite: true });
        expect(html).toContain('class="df-glow" data-on=""');
        expect(html).toContain("px-6 pt-1 pb-6");
    });

    it("draws no light when the caller opts out", () => {
        expect(frame({ noGlow: true })).not.toContain("df-glow");
    });
});

describe("DialogFrame's fill (#1047)", () => {
    it("takes the window minus the margin, grows its body and keeps the header and buttons in view", () => {
        const html = frame({ fill: true, widthClass: "w-[560px]" });
        expect(html).toMatch(/role="dialog"[^>]*class="[^"]*h-\[calc\(100vh-64px\)\] w-\[calc\(100vw-32px\)\]/);
        expect(html).not.toContain("w-[560px]");
        expect(html).toMatch(/class="[^"]*min-h-0[^"]*overflow-auto[^"]*flex-1/);
        expect(html).toMatch(/data-dialog-buttons="true" class="[^"]*\bshrink-0\b/);
        expect(html).toMatch(/class="shrink-0 border-b/);
    });

    it("keeps the caller's width without fill", () => {
        const html = frame({ widthClass: "w-[560px]" });
        expect(html).toContain("w-[560px]");
        expect(html).not.toContain(" w-[calc(100vw-32px)]");
        expect(html).not.toContain("flex-1");
    });
});
