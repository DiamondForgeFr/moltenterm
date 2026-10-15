// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release notification of 1.0.0 (#188, FR-REL-005 reduced): an installed release learns from the repository's
// GitHub Releases that a newer release of its channel is out, and says so once with its notes and a download link.
// Nothing is downloaded or installed (that waits for signed builds, #507). Shared by emain (the request and its cache)
// and the renderer (the notification), and kept free of both so that the rules are tested alone.

import { GitHubReleaseLink, isWebLink } from "../../util/moltenterm-web-link";
import { compareVersions, releaseOf, Version, VersionRules } from "../releases/versions";

// At most one request a day, whatever the number of windows and restarts.
export const ReleaseCheckIntervalMs = 24 * 60 * 60 * 1000;
// After a failed request (offline, rate limit), the next try.
export const ReleaseRetryIntervalMs = 60 * 60 * 1000;
// What is kept of each release's body: far more than the notes the notification shows.
const MaxBodyChars = 20_000;
export const ReleaseFeedTimeoutMs = 10_000;
// The notes shown in the notification; the release page has them all.
export const ReleaseNotesMaxChars = 600;
// The GitHub release body is the public notes, then the install text release.yml appends under this heading
// (UPSTREAM.md, "Release notes").
const InstallHeadingRegex = /^##\s+Install\b/m;
const OwnVersionRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/;

// must match the channel in emain/preload.ts
export const MoltentermReleaseCheckChannel = "moltenterm-release-check";

// What the GitHub Releases API returns, reduced to what is read.
export type GithubRelease = {
    tag_name: string;
    name?: string;
    draft?: boolean;
    prerelease?: boolean;
    html_url?: string;
    body?: string;
    published_at?: string;
};

export type ReleaseOffer = {
    tag: string;
    version: string;
    url: string;
    notes: string;
    publishedat: string;
};

export type ReleaseCheck = {
    // false for builds that never look (gold, dev, local builds).
    enabled: boolean;
    offer?: ReleaseOffer;
    checkedat?: number;
    error?: string;
    // Set for the first window told of this offer: it publishes the notification.
    announce?: boolean;
    // A release announced before and no longer offered: its notification is withdrawn.
    withdraw?: string;
};

// emain's memory of the day's check: the releases read (the offer is picked from them at every answer), and the
// release already announced.
export type ReleaseCheckCache = {
    checkedat: number;
    releases: GithubRelease[];
    notifiedtag?: string;
    error?: string;
    failed?: boolean;
};

// Only the builds made by the release workflow look: a gold updates from the local builds folder (#64), a dev or
// local build never.
export function releaseFeedEnabled(channel: string, isPackaged: boolean): boolean {
    return isPackaged && (channel === "rc" || channel === "public");
}

export function dueForCheck(cache: ReleaseCheckCache, now: number): boolean {
    if (cache == null || !Number.isFinite(cache.checkedat)) {
        return true;
    }
    // A clock set back would otherwise silence the check until it caught up.
    if (now < cache.checkedat) {
        return true;
    }
    return now - cache.checkedat >= (cache.failed ? ReleaseRetryIntervalMs : ReleaseCheckIntervalMs);
}

function str(value: any): string {
    return typeof value === "string" ? value : undefined;
}

// The releases as kept: only the fields read, with the right types, whatever the feed or the cache file held.
export function feedReleasesOf(list: any): GithubRelease[] {
    if (!Array.isArray(list)) {
        return [];
    }
    const rtn: GithubRelease[] = [];
    for (const r of list) {
        if (r == null || typeof r !== "object" || typeof r.tag_name !== "string" || r.draft === true) {
            continue;
        }
        rtn.push({
            tag_name: r.tag_name,
            prerelease: r.prerelease === true,
            html_url: str(r.html_url),
            body: str(r.body)?.slice(0, MaxBodyChars),
            published_at: str(r.published_at),
        });
    }
    return rtn;
}

// Whether a release is newer than the running version. The running version may be X.Y.Z-0 (the version between two
// releases, before the first candidate), which comes before every release of X.Y.Z.
export function isNewerRelease(release: Version, ownVersion: string): boolean {
    const m = OwnVersionRegex.exec(ownVersion ?? "");
    if (!m || release == null) {
        return false;
    }
    const own: Version = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc: Number(m[4] ?? 0) };
    if (m[4] === "0") {
        const head = compareVersions({ ...release, rc: 0 }, { ...own, rc: 0 });
        return head >= 0;
    }
    return compareVersions(release, own) > 0;
}

export function releaseNotesOf(body: string): string {
    let text = (body ?? "").replace(/\r\n/g, "\n");
    const install = InstallHeadingRegex.exec(text);
    if (install) {
        text = text.slice(0, install.index);
    }
    text = text.trim();
    if (text.length <= ReleaseNotesMaxChars) {
        return text;
    }
    const cut = text.lastIndexOf("\n", ReleaseNotesMaxChars);
    return text.slice(0, cut > ReleaseNotesMaxChars / 2 ? cut : ReleaseNotesMaxChars).trimEnd() + "\n…";
}

// The newest published release the build's channel is offered, if it is newer than the build: a public build is only
// offered public releases, a release candidate the newer of the next candidate and a public release.
export function pickReleaseOffer(
    releases: readonly GithubRelease[],
    channel: string,
    ownVersion: string,
    rules: VersionRules = {}
): ReleaseOffer {
    let best: GithubRelease = null;
    let bestVersion: Version = null;
    for (const release of releases ?? []) {
        if (release == null || release.draft || typeof release.tag_name !== "string") {
            continue;
        }
        const v = releaseOf(rules, release.tag_name);
        if (v == null) {
            continue;
        }
        if (channel === "public" && (v.rc !== 0 || release.prerelease)) {
            continue;
        }
        if (!isNewerRelease(v, ownVersion) || !isWebLink(release.html_url, GitHubReleaseLink)) {
            continue;
        }
        if (bestVersion == null || compareVersions(v, bestVersion) > 0) {
            best = release;
            bestVersion = v;
        }
    }
    if (best == null) {
        return null;
    }
    return {
        tag: best.tag_name,
        version: best.tag_name.replace(/^[^0-9]*/, ""),
        url: best.html_url,
        notes: releaseNotesOf(best.body),
        publishedat: best.published_at ?? "",
    };
}

// The Releases API of the repository the app comes from. A test instance (MOLTENTERM_BACKGROUND=1, UPSTREAM.md) may
// point it at a feed served on this machine (MOLTENTERM_RELEASE_FEED_URL, http://127.0.0.1 only); any other override
// is ignored.
export function releaseFeedUrl(repoUrl: string, env: Record<string, string | undefined>): string {
    const override = env?.MOLTENTERM_RELEASE_FEED_URL;
    if (override && env?.MOLTENTERM_BACKGROUND === "1") {
        try {
            const url = new URL(override);
            if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
                return url.toString();
            }
        } catch {
            // unreadable: the real feed is used
        }
    }
    const repo = new URL(repoUrl).pathname.replace(/^\/|\/$/g, "");
    return `https://api.github.com/repos/${repo}/releases?per_page=30`;
}

// The notification shows plain text on a few lines: the notes' headings become labels ("New: a; b. Fixed: c."), list
// marks and emphasis are dropped.
export function notesAsText(notes: string): string {
    const sections: string[] = [];
    let label = "";
    let items: string[] = [];
    const flush = () => {
        if (items.length > 0) {
            sections.push(`${label ? `${label}: ` : ""}${items.join("; ")}.`.replace(/([.!?…])\.$/, "$1"));
        }
        items = [];
    };
    for (const raw of (notes ?? "").split("\n")) {
        const line = raw.trim();
        if (line === "") {
            continue;
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
            flush();
            label = heading[1].trim();
            continue;
        }
        const text = line
            .replace(/^[-*+]\s+|^\d+\.\s+/, "")
            .replace(/[*_`]/g, "")
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .trim();
        if (text) {
            items.push(text.replace(/[.;]$/, ""));
        }
    }
    flush();
    return sections.join(" ");
}

export function releaseNotificationTitle(offer: ReleaseOffer): string {
    return `MoltenTerm ${offer.version} is available`;
}
