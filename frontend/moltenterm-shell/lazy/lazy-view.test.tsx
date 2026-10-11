// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The real modules pull monaco and streamdown; the boundary must never evaluate them while rendering its fallback.
const loaded = vi.hoisted(() => ({ monaco: 0, streamdown: 0 }));
vi.mock("@/app/monaco/monaco-react", () => {
    loaded.monaco++;
    return { MonacoCodeEditor: () => <div>real editor</div>, MonacoDiffViewer: () => <div>real diff</div> };
});
vi.mock("@/app/element/streamdown", () => {
    loaded.streamdown++;
    return { WaveStreamdown: ({ text }: { text: string }) => <div>formatted {text}</div> };
});

import { MonacoCodeEditor, MonacoDiffViewer } from "./monaco-lazy";
import { WaveStreamdown } from "./streamdown-lazy";

describe("lazy view boundaries", () => {
    // first, before any render starts loading them
    it("does not load the heavy modules at import time", () => {
        expect(loaded).toEqual({ monaco: 0, streamdown: 0 });
    });

    it("shows the editor's loading state until monaco has loaded", () => {
        const html = renderToStaticMarkup(<MonacoCodeEditor text="x" readonly={true} path="p" options={{}} />);
        expect(html).toContain('data-testid="lazy-view-loading"');
        expect(html).toContain("Loading editor…");
        expect(html).not.toContain("real editor");
    });

    it("shows the diff's loading state until monaco has loaded", () => {
        const html = renderToStaticMarkup(<MonacoDiffViewer original="a" modified="b" path="p" options={{}} />);
        expect(html).toContain("Loading diff…");
    });

    it("shows a streamdown message as plain text until streamdown has loaded", () => {
        const html = renderToStaticMarkup(<WaveStreamdown text={"**bold** <tag>"} className="extra" />);
        expect(html).toContain('data-testid="lazy-streamdown-loading"');
        expect(html).toContain("whitespace-pre-wrap");
        expect(html).toContain("extra");
        expect(html).toContain("**bold** &lt;tag&gt;");
    });

    it("renders the real view once the module has loaded", async () => {
        await import("@/app/monaco/monaco-react");
        await new Promise((r) => setTimeout(r, 0));
        const html = renderToStaticMarkup(<MonacoCodeEditor text="x" readonly={true} path="p" options={{}} />);
        expect(html).toContain("real editor");
    });
});
