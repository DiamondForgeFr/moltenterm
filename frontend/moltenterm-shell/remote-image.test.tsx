// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../app/element/markdown";
import { withoutRemoteCandidates } from "../app/element/markdown-util";
import { isRemoteImage, RemoteImageLink } from "./remote-image";

// #2045, FR-BRW-014: the app page's Content-Security-Policy loads no image from a web address, so a remote image is
// shown as a link and never as an <img> the page would request.
describe("remote images in the app page", () => {
    it("tells a web image from one the app may load", () => {
        expect(isRemoteImage("https://tracker.example/p.png")).toBe(true);
        expect(isRemoteImage(" HTTP://tracker.example/p.png")).toBe(true);
        expect(isRemoteImage("data:image/png;base64,AA")).toBe(false);
        expect(isRemoteImage("./diagram.png")).toBe(false);
        expect(isRemoteImage(undefined)).toBe(false);
    });

    it("draws a remote image as a link with its description and its site, never as an image", () => {
        const html = renderToStaticMarkup(<RemoteImageLink src="https://www.tracker.example/p.png" alt="Build status" />);
        expect(html).not.toContain("<img");
        expect(html).toContain('href="https://www.tracker.example/p.png"');
        expect(html).toContain("Build status");
        expect(html).toContain("tracker.example");
    });

    it("names the site when the image has no description", () => {
        const html = renderToStaticMarkup(<RemoteImageLink src="https://tracker.example/p.png" />);
        expect(html).toContain("Image from tracker.example");
    });

    it("keeps a markdown file's remote image out of the page", () => {
        const html = renderToStaticMarkup(
            <Markdown text={"![pixel](https://tracker.example/p.png)\n\n<img src=\"https://tracker.example/q.png\">"} />
        );
        expect(html).not.toMatch(/<img[^>]+https:\/\/tracker\.example/);
        expect(html.match(/data-testid="remote-image-link"/g)?.length).toBe(2);
    });

    it("drops the remote candidates of a srcset, and keeps the others", () => {
        expect(withoutRemoteCandidates("https://t.example/a.png 1x, data:image/png;base64,AA 2x")).toBe(
            "data:image/png;base64,AA 2x"
        );
        expect(withoutRemoteCandidates("https://t.example/a.png 1x")).toBeUndefined();
        expect(withoutRemoteCandidates(undefined)).toBeUndefined();
    });
});
