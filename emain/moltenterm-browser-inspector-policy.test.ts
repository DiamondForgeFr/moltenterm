// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    cookiesToRestore,
    cookieUrl,
    inspectPoint,
    ownCookies,
    placeBounds,
    restoreDetails,
    siteOriginOf,
    SiteStorages,
} from "./moltenterm-browser-inspector-policy";

describe("where the docked tools go (FR-BRW-022, DS-BRW-027)", () => {
    it("scales the pane's CSS rectangle by the window's zoom and shows it", () => {
        expect(placeBounds({ x: 10.4, y: 300, width: 600, height: 240.6, visible: true }, 1.25)).toEqual({
            bounds: { x: 13, y: 375, width: 750, height: 301 },
            visible: true,
        });
    });

    it("hides the view when the window says so or when nothing of it would show", () => {
        expect(placeBounds({ x: 0, y: 0, width: 600, height: 300, visible: false }, 1).visible).toBe(false);
        expect(placeBounds({ x: 0, y: 0, width: 0, height: 300, visible: true }, 1).visible).toBe(false);
        expect(placeBounds({ x: 0, y: 0, width: 600, height: 300, visible: "yes" }, 1).visible).toBe(false);
    });

    it("refuses what is not a rectangle, and reads a bad zoom as 1", () => {
        for (const raw of [null, "x", { x: 0, y: 0, width: -1, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
            expect(placeBounds(raw, 1), JSON.stringify(raw)).toBeNull();
        }
        expect(placeBounds({ x: 0, y: 0, width: 1e9, height: 1 }, 1)).toBeNull();
        expect(placeBounds({ x: 1, y: 2, width: 3, height: 4, visible: true }, 0).bounds).toEqual({
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        });
    });

    it("selects the right-click's window point in DIP, and no point without one", () => {
        expect(inspectPoint({ x: 40, y: 20.2 }, 1.5)).toEqual({ x: 60, y: 30 });
        expect(inspectPoint(null, 1)).toBeNull();
        expect(inspectPoint({ x: -1, y: 0 }, 1)).toBeNull();
        expect(inspectPoint({ x: "1", y: 0 }, 1)).toBeNull();
    });
});

describe("the site a page clears (FR-BRW-022 AC7)", () => {
    it("is the origin of an http or https page, with the host its cookies belong to", () => {
        expect(siteOriginOf("http://LocalHost:3000/app?x=1#y")).toEqual({
            origin: "http://localhost:3000",
            host: "localhost",
        });
        expect(siteOriginOf("https://[::1]:8443/")).toEqual({ origin: "https://[::1]:8443", host: "::1" });
        for (const url of ["file:///tmp/a.html", "about:blank", "data:text/html,x", "molten://start", "", null, "::"]) {
            expect(siteOriginOf(url), String(url)).toBeNull();
        }
    });

    it("clears every storage of the origin but its cookies, which go one by one", () => {
        expect([...SiteStorages]).not.toContain("cookies");
        expect([...SiteStorages]).toEqual(
            expect.arrayContaining(["localstorage", "indexdb", "serviceworkers", "cachestorage"])
        );
    });
});

describe("the cookies of a site (FR-BRW-022 AC7)", () => {
    const host = (name: string, extra = {}) => ({
        name,
        domain: "app.example.test",
        hostOnly: true,
        path: "/",
        ...extra,
    });
    const shared = (name: string, extra = {}) => ({
        name,
        domain: ".example.test",
        hostOnly: false,
        path: "/",
        ...extra,
    });

    it("takes only the host-only cookies of the very host: every domain cookie is shared, and stays", () => {
        const all = [
            host("sid"),
            { name: "pref", domain: ".app.example.test", hostOnly: false, path: "/" },
            shared("sso"),
            { name: "other", domain: "www.example.test", hostOnly: true, path: "/" },
            { name: "loose", domain: "app.example.test", path: "/" },
        ];
        expect(ownCookies(all, "APP.example.test").map((c) => c.name)).toEqual(["sid"]);
    });

    it("names a cookie by its own host, path and scheme", () => {
        expect(cookieUrl(host("sid", { path: "/deep", secure: true }))).toBe("https://app.example.test/deep");
        expect(cookieUrl({ name: "a", domain: "::1", path: "" })).toBe("http://[::1]/");
    });

    it("sets back the shared cookies the removal took along, the host's own domain cookie too, and nothing it meant to remove", () => {
        const ownDomain = { name: "sid", domain: ".app.example.test", hostOnly: false, path: "/", value: "sub" };
        const before = [host("sid"), shared("sid", { value: "keep" }), ownDomain, shared("other")];
        const after = [shared("other")];
        expect(cookiesToRestore(before, after, [host("sid")])).toEqual([shared("sid", { value: "keep" }), ownDomain]);
        expect(cookiesToRestore(before, before, [host("sid")])).toEqual([]);
    });

    it("sets a cookie back as it was: domain, path, flags, expiry", () => {
        expect(
            restoreDetails(
                shared("sso", {
                    value: "v",
                    secure: true,
                    httpOnly: true,
                    session: false,
                    expirationDate: 1900000000,
                    sameSite: "lax",
                })
            )
        ).toEqual({
            url: "https://example.test/",
            name: "sso",
            value: "v",
            domain: ".example.test",
            path: "/",
            secure: true,
            httpOnly: true,
            expirationDate: 1900000000,
            sameSite: "lax",
        });
        const session = restoreDetails(host("sid", { session: true, expirationDate: 5 }));
        expect(session.domain).toBeUndefined();
        expect(session.expirationDate).toBeUndefined();
    });
});
