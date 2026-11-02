// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { GitHubReleaseLink, isWebLink } from "../../util/moltenterm-web-link";
import { parseVersion } from "../releases/versions";
import {
    dueForCheck,
    feedReleasesOf,
    GithubRelease,
    isNewerRelease,
    notesAsText,
    pickReleaseOffer,
    ReleaseCheckIntervalMs,
    releaseFeedEnabled,
    releaseFeedUrl,
    ReleaseNotesMaxChars,
    releaseNotesOf,
    releaseNotificationTitle,
    ReleaseRetryIntervalMs,
} from "./release-feed";

const Rules = { tagprefix: "v", firstpublic: "1.0.0" };

function release(tag: string, more: Partial<GithubRelease> = {}): GithubRelease {
    return {
        tag_name: tag,
        prerelease: tag.includes("-"),
        draft: false,
        html_url: `https://github.com/DiamondForgeFr/moltenterm/releases/tag/${tag}`,
        body: `Notes of ${tag}\n\n## Install\n\n- macOS: open the dmg`,
        published_at: "2026-10-20T10:00:00Z",
        ...more,
    };
}

describe("release notification (#188)", () => {
    it("only looks from release builds", () => {
        expect(releaseFeedEnabled("rc", true)).toBe(true);
        expect(releaseFeedEnabled("public", true)).toBe(true);
        expect(releaseFeedEnabled("gold", true)).toBe(false);
        expect(releaseFeedEnabled("local", true)).toBe(false);
        expect(releaseFeedEnabled("rc", false)).toBe(false);
    });

    it("asks at most once a day", () => {
        const now = 1_000_000_000_000;
        expect(dueForCheck(null, now)).toBe(true);
        expect(dueForCheck({ checkedat: now - 1000, releases: [] }, now)).toBe(false);
        expect(dueForCheck({ checkedat: now - ReleaseCheckIntervalMs, releases: [] }, now)).toBe(true);
        expect(dueForCheck({ checkedat: now + 60_000, releases: [] }, now)).toBe(true);
        expect(dueForCheck({ checkedat: Number.NaN, releases: [] }, now)).toBe(true);
        expect(dueForCheck({ checkedat: now - ReleaseRetryIntervalMs, releases: [], failed: true }, now)).toBe(true);
        expect(dueForCheck({ checkedat: now - ReleaseRetryIntervalMs, releases: [] }, now)).toBe(false);
    });

    it("compares with the running version, X.Y.Z-0 coming before every release of X.Y.Z", () => {
        expect(isNewerRelease(parseVersion("1.0.0-1"), "1.0.0-0")).toBe(true);
        expect(isNewerRelease(parseVersion("1.0.0"), "1.0.0-0")).toBe(true);
        expect(isNewerRelease(parseVersion("0.9.0"), "1.0.0-0")).toBe(false);
        expect(isNewerRelease(parseVersion("1.0.0-2"), "1.0.0-2")).toBe(false);
        expect(isNewerRelease(parseVersion("1.0.0"), "1.0.0-2")).toBe(true);
        expect(isNewerRelease(parseVersion("1.0.1"), "1.0.0")).toBe(true);
        expect(isNewerRelease(parseVersion("1.0.0"), "1.0.0")).toBe(false);
        expect(isNewerRelease(parseVersion("1.0.1"), "not a version")).toBe(false);
    });

    it("offers only public releases, newer than the build, when candidates are off", () => {
        const releases = [
            release("v1.0.0"),
            release("v1.0.1-1"),
            release("v1.0.1", { draft: true }),
            release("v0.9.0"),
        ];
        expect(pickReleaseOffer(releases, false, "1.0.0", Rules)).toBeNull();
        const offer = pickReleaseOffer([...releases, release("v1.0.1")], false, "1.0.0", Rules);
        expect(offer.tag).toBe("v1.0.1");
        expect(offer.version).toBe("1.0.1");
        expect(offer.notes).toBe("Notes of v1.0.1");
        expect(releaseNotificationTitle(offer)).toBe("MoltenTerm 1.0.1 is available");
    });

    it("offers the newer of the next candidate and a public release when candidates are on", () => {
        const releases = [release("v1.0.0-1"), release("v1.0.0-2"), release("v1.0.0")];
        expect(pickReleaseOffer(releases, true, "1.0.0-1", Rules).tag).toBe("v1.0.0");
        expect(pickReleaseOffer(releases.slice(0, 2), true, "1.0.0-1", Rules).tag).toBe("v1.0.0-2");
        expect(pickReleaseOffer(releases, true, "1.0.0", Rules)).toBeNull();
    });

    // #948: the preference alone decides, whatever build was installed first.
    describe("installed version × release candidates preference × available releases", () => {
        const feed = [
            release("v0.9.0"),
            release("v1.0.0-5"),
            release("v1.0.0-6"),
            release("v1.0.0-7"),
            release("v1.0.0"),
            release("v1.0.1-1"),
        ];
        const cases: [string, string, boolean, readonly GithubRelease[], string][] = [
            ["a candidate install, off, a newer public release out", "1.0.0-6", false, feed, "v1.0.0"],
            ["a candidate install, off, only newer candidates out", "1.0.0-6", false, feed.slice(0, 4), null],
            ["a candidate install, off, only an older public release", "1.0.0-6", false, [release("v0.9.0")], null],
            ["a candidate install, on, a newer candidate only", "1.0.0-6", true, feed.slice(0, 4), "v1.0.0-7"],
            ["a candidate install, on, candidate and public out", "1.0.0-6", true, feed, "v1.0.1-1"],
            ["a public install, off, only a newer candidate", "1.0.0", false, feed, null],
            ["a public install, on, a newer candidate", "1.0.0", true, feed, "v1.0.1-1"],
            [
                "a public install, on, a newer public release beats an older candidate",
                "1.0.0",
                true,
                [...feed, release("v1.0.1")],
                "v1.0.1",
            ],
            ["a public install, off, a newer public release", "1.0.0", false, [...feed, release("v1.0.1")], "v1.0.1"],
            ["a public install, on, nothing newer", "1.0.1", true, feed, null],
            [
                "a candidate install, off, a prerelease without -N is still a candidate",
                "1.0.0-6",
                false,
                [release("v1.0.0", { prerelease: true })],
                null,
            ],
        ];
        for (const [name, installed, candidates, releases, expected] of cases) {
            it(name, () => {
                expect(pickReleaseOffer(releases, candidates, installed, Rules)?.tag ?? null).toBe(expected);
            });
        }
    });

    it("never offers a release marked as prerelease when candidates are off, a foreign tag or an unsafe link", () => {
        expect(pickReleaseOffer([release("v1.1.0", { prerelease: true })], false, "1.0.0", Rules)).toBeNull();
        expect(pickReleaseOffer([release("v0.14.5")], true, "0.1.0", Rules)).toBeNull();
        expect(pickReleaseOffer([release("nightly")], true, "1.0.0-0", Rules)).toBeNull();
        expect(
            pickReleaseOffer([release("v1.0.1", { html_url: "javascript:alert(1)" })], false, "1.0.0", Rules)
        ).toBeNull();
        expect(pickReleaseOffer([null, { tag_name: null } as any], false, "1.0.0", Rules)).toBeNull();
    });

    it("shows the public notes only, shortened", () => {
        expect(releaseNotesOf("Hello\r\n\r\n## Install\r\nxattr")).toBe("Hello");
        expect(releaseNotesOf("## New\n\n- a\n- b")).toBe("## New\n\n- a\n- b");
        expect(releaseNotesOf(null)).toBe("");
        const long = Array.from({ length: 60 }, (_, i) => `- change number ${i}`).join("\n");
        const short = releaseNotesOf(long);
        expect(short.length).toBeLessThanOrEqual(ReleaseNotesMaxChars + 2);
        expect(short.endsWith("\n…")).toBe(true);
    });

    it("asks the repository's Releases API, or a loopback test feed only", () => {
        const repo = "https://github.com/DiamondForgeFr/moltenterm";
        expect(releaseFeedUrl(repo, {})).toBe(
            "https://api.github.com/repos/DiamondForgeFr/moltenterm/releases?per_page=30"
        );
        const test = { MOLTENTERM_BACKGROUND: "1" };
        expect(releaseFeedUrl(repo, { ...test, MOLTENTERM_RELEASE_FEED_URL: "http://127.0.0.1:9/feed.json" })).toBe(
            "http://127.0.0.1:9/feed.json"
        );
        expect(releaseFeedUrl(repo, { MOLTENTERM_RELEASE_FEED_URL: "http://127.0.0.1:9/feed.json" })).toContain(
            "api.github.com"
        );
        expect(releaseFeedUrl(repo, { ...test, MOLTENTERM_RELEASE_FEED_URL: "http://localhost:9/feed" })).toContain(
            "api.github.com"
        );
        expect(releaseFeedUrl(repo, { ...test, MOLTENTERM_RELEASE_FEED_URL: "https://evil.example/feed" })).toContain(
            "api.github.com"
        );
        expect(releaseFeedUrl(repo, { ...test, MOLTENTERM_RELEASE_FEED_URL: "::" })).toContain("api.github.com");
    });

    it("turns the notes into plain text for the notification", () => {
        const notes =
            "## New\n\n- Workspaces **remember** their agents.\n- A [browser](https://x) panel\n\n## Fixed\n\n- The status bar";
        expect(notesAsText(notes)).toBe(
            "New: Workspaces remember their agents; A browser panel. Fixed: The status bar."
        );
        expect(notesAsText("Just one sentence!")).toBe("Just one sentence!");
        expect(notesAsText("")).toBe("");
    });

    it("opens only release pages on github.com, and keeps only what it reads of the feed", () => {
        expect(isWebLink("https://github.com/DiamondForgeFr/moltenterm/releases/tag/v1.0.0", GitHubReleaseLink)).toBe(
            true
        );
        expect(isWebLink("https://evil.example/DiamondForgeFr/moltenterm/releases/tag/v1", GitHubReleaseLink)).toBe(
            false
        );
        expect(isWebLink("https://github.com/DiamondForgeFr/moltenterm/issues/1", GitHubReleaseLink)).toBe(false);
        expect(isWebLink("http://github.com/a/b/releases/tag/v1", GitHubReleaseLink)).toBe(false);
        const kept = feedReleasesOf([
            { tag_name: "v1.0.1", body: 42, html_url: ["x"], prerelease: "yes", extra: 1 },
            { tag_name: "v1.0.2", draft: true },
            "junk",
            null,
        ]);
        expect(kept).toEqual([
            { tag_name: "v1.0.1", prerelease: false, html_url: undefined, body: undefined, published_at: undefined },
        ]);
        expect(feedReleasesOf({})).toEqual([]);
        // An unsafe link on the newest release falls back to the next one.
        const offer = pickReleaseOffer(
            [release("v1.0.2", { html_url: "https://evil.example/r" }), release("v1.0.1")],
            false,
            "1.0.0",
            Rules
        );
        expect(offer.tag).toBe("v1.0.1");
    });
});
