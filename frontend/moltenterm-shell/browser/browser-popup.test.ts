// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    centerIn,
    classifyWindowOpen,
    detectSignInRefusal,
    isSignInProviderUrl,
    parseWindowFeatures,
    popupBounds,
    PopupDefaultHeight,
    PopupDefaultWidth,
    PopupMinSize,
    popupTitle,
    signInDismiss,
    signInOnNavigate,
    signInOnPopupRefused,
} from "./browser-popup";

const Site = "https://claude.ai/artifact/123";

function b64url(text: string): string {
    return Buffer.from(text, "latin1").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("classifyWindowOpen", () => {
    it("opens a sized window.open as a popup", () => {
        expect(
            classifyWindowOpen({
                url: "https://github.com/login/oauth",
                features: "width=480,height=600",
                disposition: "new-window",
            })
        ).toBe("popup");
    });

    it("follows the popup feature", () => {
        expect(classifyWindowOpen({ url: Site, features: "popup", disposition: "new-window" })).toBe("popup");
        expect(classifyWindowOpen({ url: Site, features: "popup=1", disposition: "new-window" })).toBe("popup");
        expect(classifyWindowOpen({ url: Site, features: "popup=yes", disposition: "foreground-tab" })).toBe("popup");
        expect(classifyWindowOpen({ url: Site, features: "popup=0", disposition: "new-window" })).toBe("tab");
    });

    it("keeps links and feature-less window.open as tabs", () => {
        expect(classifyWindowOpen({ url: Site, features: "", disposition: "foreground-tab" })).toBe("tab");
        expect(classifyWindowOpen({ url: Site, features: "", disposition: "background-tab" })).toBe("tab");
        expect(classifyWindowOpen({ url: Site })).toBe("tab");
    });

    it("gives an empty window to its opener", () => {
        expect(classifyWindowOpen({ url: "about:blank", features: "", disposition: "foreground-tab" })).toBe("popup");
        expect(classifyWindowOpen({ url: "", features: "width=500", disposition: "new-window" })).toBe("popup");
    });

    it("sends noopener windows to a tab, sized or not", () => {
        expect(classifyWindowOpen({ url: Site, features: "noopener", disposition: "foreground-tab" })).toBe("tab");
        expect(classifyWindowOpen({ url: Site, features: "noopener,width=400", disposition: "new-window" })).toBe(
            "tab"
        );
        expect(classifyWindowOpen({ url: Site, features: "noreferrer,width=400", disposition: "new-window" })).toBe(
            "tab"
        );
    });

    it("forwards other schemes as before and denies script URLs", () => {
        expect(
            classifyWindowOpen({ url: "mailto:a@example.com", features: "width=400", disposition: "new-window" })
        ).toBe("tab");
        expect(
            classifyWindowOpen({ url: "javascript:alert(1)", features: "width=400", disposition: "new-window" })
        ).toBe("deny");
        expect(classifyWindowOpen({ url: " JavaScript:void(0)", disposition: "foreground-tab" })).toBe("deny");
    });
});

describe("popupBounds", () => {
    it("parses the size and position", () => {
        expect(popupBounds("width=480,height=600,left=10,top=20")).toEqual({ width: 480, height: 600, x: 10, y: 20 });
        expect(popupBounds("width=480, height=600")).toEqual({ width: 480, height: 600 });
    });

    it("defaults and clamps", () => {
        expect(popupBounds("")).toEqual({ width: PopupDefaultWidth, height: PopupDefaultHeight });
        expect(popupBounds("width=10,height=abc")).toEqual({ width: PopupMinSize, height: PopupDefaultHeight });
        expect(popupBounds("width=100000,height=-5").width).toBe(4000);
    });

    it("needs both coordinates to place the window", () => {
        expect(popupBounds("width=400,left=10")).toEqual({ width: 400, height: PopupDefaultHeight });
    });

    it("centres on the parent", () => {
        expect(centerIn({ width: 400, height: 300 }, { x: 100, y: 50, width: 1000, height: 800 })).toEqual({
            x: 400,
            y: 300,
        });
    });

    it("reads bare and valued features", () => {
        expect(parseWindowFeatures("popup,Width=3 noopener")).toEqual({ popup: "", width: "3", noopener: "" });
    });
});

describe("popupTitle", () => {
    it("puts the site first", () => {
        expect(popupTitle("https://github.com/login", "Sign in to GitHub")).toBe("github.com — Sign in to GitHub");
        expect(popupTitle("https://github.com/login", "")).toBe("github.com");
        expect(popupTitle("about:blank", "x")).toBe("x");
    });
});

describe("detectSignInRefusal", () => {
    it("recognises Google's refusal pages", () => {
        const google = { provider: "google", label: "Google" };
        expect(detectSignInRefusal("https://accounts.google.com/v3/signin/rejected?continue=x")).toEqual(google);
        expect(detectSignInRefusal("https://accounts.google.com/signin/rejected")).toEqual(google);
        expect(
            detectSignInRefusal(
                "https://accounts.google.com/signin/oauth/error?authError=" + b64url("\n\x14disallowed_useragent\x12x")
            )
        ).toEqual(google);
        expect(
            detectSignInRefusal("https://accounts.google.com/signin/oauth/error?error=disallowed_useragent")
        ).toEqual(google);
    });

    it("ignores other pages and look-alike hosts", () => {
        expect(detectSignInRefusal("https://accounts.google.com/v3/signin/identifier")).toBeNull();
        expect(detectSignInRefusal("https://accounts.google.com.evil.example/signin/rejected")).toBeNull();
        expect(detectSignInRefusal("https://evil.example/v3/signin/rejected")).toBeNull();
        expect(detectSignInRefusal("not a url")).toBeNull();
        expect(detectSignInRefusal(null)).toBeNull();
        expect(
            detectSignInRefusal(
                "https://accounts.google.com/signin/oauth/error?authError=" + b64url("\nredirect_uri_mismatch")
            )
        ).toBeNull();
        expect(detectSignInRefusal("https://accounts.google.com/signin/oauth/error?authError=%%%")).toBeNull();
    });

    it("knows the provider's pages", () => {
        expect(isSignInProviderUrl("https://accounts.google.com/o/oauth2/auth")).toBe(true);
        expect(isSignInProviderUrl(Site)).toBe(false);
    });
});

describe("sign-in tab state", () => {
    const Rejected = "https://accounts.google.com/v3/signin/rejected";

    it("shows the bar on a refusal in the tab, returning to the last site page", () => {
        let s = signInOnNavigate(undefined, Site);
        s = signInOnNavigate(s, "https://accounts.google.com/o/oauth2/auth?client_id=1");
        expect(s.bar).toBeUndefined();
        s = signInOnNavigate(s, Rejected);
        expect(s.bar).toEqual({ provider: "google", label: "Google", returnUrl: Site, host: "accounts.google.com" });
    });

    it("falls back to the refusal page when no site page came first", () => {
        expect(signInOnNavigate(undefined, Rejected).bar.returnUrl).toBe(Rejected);
    });

    it("clears the bar when the tab reaches another site, not on the same site", () => {
        let s = signInOnPopupRefused({ lastSiteUrl: Site }, { provider: "google", label: "Google" }, Site);
        expect(s.bar.returnUrl).toBe(Site);
        s = signInOnNavigate(s, "https://claude.ai/new");
        expect(s.bar).toBeDefined();
        s = signInOnNavigate(s, "about:blank");
        expect(s.bar).toBeDefined();
        s = signInOnNavigate(s, "https://example.com/");
        expect(s.bar).toBeUndefined();
    });

    it("continues from the last site page when the tab itself is on the provider", () => {
        const s = signInOnPopupRefused(
            { lastSiteUrl: Site },
            { provider: "google", label: "Google" },
            "https://accounts.google.com/x"
        );
        expect(s.bar.returnUrl).toBe(Site);
    });

    it("dismisses", () => {
        const s = signInOnNavigate({ lastSiteUrl: Site }, Rejected);
        expect(signInDismiss(s)).toEqual({ lastSiteUrl: Site });
        const none = { lastSiteUrl: Site };
        expect(signInDismiss(none)).toBe(none);
    });
});
