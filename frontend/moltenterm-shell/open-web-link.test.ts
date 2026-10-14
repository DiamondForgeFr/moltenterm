// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { openLink } = vi.hoisted(() => ({ openLink: vi.fn(async (_url: string) => {}) }));
vi.mock("@/app/store/global", () => ({ openLink }));

import { GitHubReleaseLink, isWebLink } from "@/util/moltenterm-web-link";
import { openWebLink } from "./open-web-link";

beforeEach(() => openLink.mockClear());

describe("web links from gh, GitHub and reviews (#663)", () => {
    it("passes http(s) pages only", () => {
        expect(isWebLink("https://github.com/o/r/pull/7")).toBe(true);
        expect(isWebLink("http://localhost:8080/x")).toBe(true);
        for (const url of [
            "file:///Volumes/share/x.app",
            "file:///etc/passwd",
            "vscode://x",
            "javascript:alert(1)",
            "data:text/html,x",
            "mailto:a@b.c",
            "https://",
            "",
            null,
            undefined,
            42,
        ]) {
            expect(isWebLink(url)).toBe(false);
        }
    });

    it("restricts a release link to a release page on github.com over https", () => {
        expect(isWebLink("https://github.com/DiamondForgeFr/moltenterm/releases/tag/v1.0.0", GitHubReleaseLink)).toBe(
            true
        );
        expect(isWebLink("https://evil.example/a/b/releases/tag/v1", GitHubReleaseLink)).toBe(false);
        expect(isWebLink("https://github.com/a/b/issues/1", GitHubReleaseLink)).toBe(false);
        expect(isWebLink("http://github.com/a/b/releases/tag/v1", GitHubReleaseLink)).toBe(false);
    });

    it("opens a web page through openLink, and never another scheme", async () => {
        expect(await openWebLink("https://github.com/o/r/actions/runs/1")).toBe(true);
        expect(openLink).toHaveBeenCalledExactlyOnceWith("https://github.com/o/r/actions/runs/1");
        openLink.mockClear();
        expect(await openWebLink("file:///Volumes/share/x.app")).toBe(false);
        expect(await openWebLink("customapp://run")).toBe(false);
        expect(await openWebLink("https://evil.example/a/b/releases/tag/v1", GitHubReleaseLink)).toBe(false);
        expect(openLink).not.toHaveBeenCalled();
    });
});
