// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The web pages MoltenTerm's interface opens from data it did not write (#663): pull request, CI and release addresses
// from gh or GitHub's API, links in a review. Such an address could name file:///…/x.app or an app's own scheme while
// the interface shows it as a GitHub link, so only an http(s) page passes, optionally restricted to one host and path.
// Pure, shared by the renderer (frontend/moltenterm-shell/open-web-link.ts) and Electron main.

export type WebLinkRule = {
    // Only https (no plain http).
    httpsOnly?: boolean;
    // The page's exact host name.
    host?: string;
    // A pattern its path must match.
    path?: RegExp;
};

// A release page of a repository on github.com: the only page the release notification ever opens.
export const GitHubReleaseLink: WebLinkRule = {
    httpsOnly: true,
    host: "github.com",
    path: /^\/[^/]+\/[^/]+\/releases\//,
};

export function isWebLink(url: unknown, rule?: WebLinkRule): boolean {
    if (typeof url !== "string" || url === "") {
        return false;
    }
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    const web = u.protocol === "https:" || (u.protocol === "http:" && !rule?.httpsOnly);
    if (!web || u.hostname === "") {
        return false;
    }
    if (rule?.host != null && u.hostname !== rule.host) {
        return false;
    }
    return rule?.path == null || rule.path.test(u.pathname);
}
