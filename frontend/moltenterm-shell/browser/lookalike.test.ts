// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    asciiHost,
    decodePunycode,
    describeDifference,
    domainOfAddress,
    editDistance,
    editsAllowed,
    isIdnHost,
    isLookalikeHold,
    knownDomainsFrom,
    labelMixesScripts,
    LookalikeIndex,
    registrableDomain,
    shownAddressHost,
    shownHost,
    skeleton,
    splitDomain,
    unicodeHost,
    type KnownDomain,
} from "./lookalike";
import { topSiteDomains, TopSites } from "./lookalike-top-sites";

const known = (...domains: string[]): KnownDomain[] => domains.map((domain) => ({ domain, source: "bookmark" }));
const hostOf = (address: string) => new URL(address).hostname;

describe("the registrable domain of a host (#2482)", () => {
    it("is the name before the public suffix, with the suffix", () => {
        expect(registrableDomain("paypal.com")).toBe("paypal.com");
        expect(registrableDomain("login.paypal.com")).toBe("paypal.com");
        expect(registrableDomain("a.b.c.example.org")).toBe("example.org");
        expect(registrableDomain("WWW.Example.COM.")).toBe("example.com");
    });

    it("keeps a suffix of several labels together", () => {
        expect(registrableDomain("www.paypal.co.uk")).toBe("paypal.co.uk");
        expect(registrableDomain("impots.gouv.fr")).toBe("impots.gouv.fr");
        expect(registrableDomain("a.b.example.com.au")).toBe("example.com.au");
    });

    it("gives a host that rents a name below its own the renter's name", () => {
        expect(registrableDomain("paypal-login.vercel.app")).toBe("paypal-login.vercel.app");
        expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
        expect(registrableDomain("vercel.app")).toBeNull();
    });

    it("is nothing for an address, localhost, a single label or a suffix", () => {
        for (const host of [
            "127.0.0.1",
            "192.168.1.20",
            "::1",
            "[::1]",
            "localhost",
            "app.localhost",
            "intranet",
            "co.uk",
            "",
            "1.2.3",
            "a..b.com",
        ]) {
            expect(registrableDomain(host), host).toBeNull();
        }
        expect(registrableDomain(undefined as unknown as string)).toBeNull();
    });

    it("reads the domain of a web address only", () => {
        expect(domainOfAddress("https://login.paypal.com/signin?x=1")).toBe("paypal.com");
        expect(domainOfAddress("http://localhost:3000/")).toBeNull();
        expect(domainOfAddress("ftp://example.com/")).toBeNull();
        expect(domainOfAddress("javascript:alert(1)")).toBeNull();
        expect(domainOfAddress("not an address")).toBeNull();
        expect(domainOfAddress("https://" + "a".repeat(9000) + ".com/")).toBeNull();
    });

    it("splits the name from its suffix", () => {
        expect(splitDomain("shop.example.co.uk")).toEqual({
            domain: "example.co.uk",
            label: "example",
            suffix: "co.uk",
        });
    });
});

describe("punycode (#2482)", () => {
    it("reads the labels the platform spells with xn--", () => {
        expect(decodePunycode("mnchen-3ya")).toBe("münchen");
        expect(decodePunycode("bcher-kva")).toBe("bücher");
        expect(decodePunycode("wgv71a119e")).toBe("日本語");
        expect(unicodeHost("xn--mnchen-3ya.de")).toBe("münchen.de");
        expect(unicodeHost("www.xn--bcher-kva.example")).toBe("www.bücher.example");
    });

    it("leaves a label that does not decode as it is", () => {
        expect(decodePunycode("!!!")).toBeNull();
        expect(decodePunycode("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz9999999999999999")).toBeNull();
        expect(unicodeHost("xn--!!!.com")).toBe("xn--!!!.com");
        expect(unicodeHost(undefined as unknown as string)).toBe("");
    });

    it("spells a typed Unicode host the way the URL parser does", () => {
        expect(asciiHost("münchen.de")).toBe("xn--mnchen-3ya.de");
        expect(asciiHost("Example.COM")).toBe("example.com");
        expect(isIdnHost("münchen.de")).toBe(true);
        expect(isIdnHost("xn--mnchen-3ya.de")).toBe(true);
        expect(isIdnHost("example.com")).toBe(false);
    });
});

describe("skeletons (#2482)", () => {
    it("folds a Cyrillic or Greek letter to the Latin one it imitates", () => {
        expect(skeleton("pаypal.com")).toBe(skeleton("paypal.com"));
        expect(skeleton("gοοgle.com")).toBe(skeleton("google.com"));
        expect(skeleton("аррӏе.com")).toBe(skeleton("apple.com"));
    });

    it("folds full-width, accented and small-capital forms", () => {
        expect(skeleton("ｐａｙｐａｌ.com")).toBe(skeleton("paypal.com"));
        expect(skeleton("pàypâl.com")).toBe(skeleton("paypal.com"));
        expect(skeleton("ɡoogle.com")).toBe(skeleton("google.com"));
    });

    it("folds the digits and letters that pass for one another in a domain", () => {
        expect(skeleton("paypa1.com")).toBe(skeleton("paypal.com"));
        expect(skeleton("g00gle.com")).toBe(skeleton("google.com"));
        expect(skeleton("paypai.com")).toBe(skeleton("paypal.com"));
        expect(skeleton("rnicrosoft.com")).toBe(skeleton("microsoft.com"));
        expect(skeleton("vvikipedia.org")).toBe(skeleton("wikipedia.org"));
    });

    it("keeps domains that differ apart", () => {
        expect(skeleton("paypal.com")).not.toBe(skeleton("paypal.net"));
        expect(skeleton("github.com")).not.toBe(skeleton("gitlab.com"));
    });
});

describe("edit distance (#2482)", () => {
    it("counts an insertion, a deletion, a substitution and a swap as one", () => {
        expect(editDistance("google", "gooogle", 2)).toBe(1);
        expect(editDistance("google", "gogle", 2)).toBe(1);
        expect(editDistance("google", "goagle", 2)).toBe(1);
        expect(editDistance("google", "googel", 2)).toBe(1);
        expect(editDistance("google", "google", 2)).toBe(0);
        expect(editDistance("github", "gitlab", 3)).toBe(2);
    });

    it("answers at once past the allowed gap in length", () => {
        expect(editDistance("short", "muchlongerthanshort", 1)).toBeGreaterThan(1);
    });

    it("allows no edit under 6 characters, one from 6, two from 10", () => {
        expect(editsAllowed(5)).toBe(0);
        expect(editsAllowed(6)).toBe(1);
        expect(editsAllowed(9)).toBe(1);
        expect(editsAllowed(10)).toBe(2);
    });
});

describe("a domain that imitates a known one (#2482)", () => {
    const index = new LookalikeIndex(
        known("paypal.com", "google.com", "microsoftonline.com", "example.co.uk", "ab.com", "ac.com")
    );

    it("is flagged when its skeleton is a known domain's", () => {
        expect(index.find(hostOf("https://pаypal.com/"))).toEqual({
            domain: asciiHost("pаypal.com"),
            resembles: "paypal.com",
            source: "bookmark",
            reason: "skeleton",
        });
        expect(index.find("paypa1.com")).toMatchObject({ resembles: "paypal.com", reason: "skeleton" });
        expect(index.find("g00gle.com")).toMatchObject({ resembles: "google.com", reason: "skeleton" });
    });

    it("is flagged one edit from a known name of 6 characters or more on the same suffix", () => {
        expect(index.find("gooogle.com")).toMatchObject({ resembles: "google.com", reason: "distance" });
        expect(index.find("googel.com")).toMatchObject({ resembles: "google.com", reason: "distance" });
        expect(index.find("paypall.com")).toMatchObject({ resembles: "paypal.com" });
        expect(index.find("exampel.co.uk")).toMatchObject({ resembles: "example.co.uk" });
    });

    it("is flagged when a lookalike letter and one edit come together", () => {
        expect(index.find("paypa11.com")).toMatchObject({ resembles: "paypal.com", reason: "distance" });
        expect(index.find("g00ogle.com")).toMatchObject({ resembles: "google.com" });
    });

    it("is flagged two edits from a name of 10 characters or more", () => {
        expect(index.find("microsoftonlnie.com")).toMatchObject({ resembles: "microsoftonline.com" });
        expect(index.find("mikrasoftonlne.com")).toBeNull();
        expect(index.find("microsoftonlne.com")).toMatchObject({ resembles: "microsoftonline.com" });
        expect(index.find("microsoftonlnee.com")).toMatchObject({ resembles: "microsoftonline.com" });
        expect(index.find("mikrosoftonline.com")).toMatchObject({ resembles: "microsoftonline.com" });
        expect(index.find("mikrosoftonlne.com")).toMatchObject({ resembles: "microsoftonline.com" });
    });

    it("is not flagged for a short name one edit away", () => {
        expect(index.find("ad.com")).toBeNull();
        expect(index.find("ab1.com")).toBeNull();
    });

    it("is not flagged on another public suffix by edit distance", () => {
        expect(index.find("gooogle.net")).toBeNull();
        expect(index.find("paypall.org")).toBeNull();
    });

    it("never flags the known domain itself or its subdomains", () => {
        expect(index.find("paypal.com")).toBeNull();
        expect(index.find("login.paypal.com")).toBeNull();
        expect(index.find("WWW.PAYPAL.COM")).toBeNull();
        expect(index.find("accounts.google.com")).toBeNull();
        expect(index.find("shop.example.co.uk")).toBeNull();
    });

    it("never flags a domain that is itself known, however close to another", () => {
        const both = new LookalikeIndex(known("google.com", "googie.com"));
        expect(both.find("google.com")).toBeNull();
        expect(both.find("googie.com")).toBeNull();
        expect(both.find("gooogle.com")).toMatchObject({ resembles: "google.com" });
    });

    it("never checks an address, localhost, a single label or a malformed host", () => {
        for (const host of ["127.0.0.1", "192.168.0.1", "localhost", "intranet", "[::1]", "", "a..com"]) {
            expect(index.find(host), host).toBeNull();
        }
        expect(index.find(undefined as unknown as string)).toBeNull();
    });

    it("does not flag two real services with close names that are both known", () => {
        const dev = new LookalikeIndex(known("github.com", "gitlab.com"));
        expect(dev.find("github.com")).toBeNull();
        expect(dev.find("gitlab.com")).toBeNull();
    });

    it("compares a rented name by its own registrable domain", () => {
        const rented = new LookalikeIndex(known("paypal.com"));
        expect(rented.find("paypal-login.vercel.app")).toBeNull();
        expect(rented.find("paypa1.vercel.app")).toBeNull();
    });

    it("prefers the nearest known domain, and the developer's own over the bundled list", () => {
        const mixed = new LookalikeIndex([
            { domain: "googel.com", source: "frequent" },
            { domain: "google.com", source: "top" },
        ]);
        expect(mixed.find("gooogel.com")).toMatchObject({ resembles: "googel.com", source: "frequent" });
        const same = new LookalikeIndex([
            { domain: "paypal.com", source: "bookmark" },
            { domain: "paypal.com", source: "top" },
        ]);
        expect(same.size()).toBe(1);
        expect(same.find("paypa1.com")).toMatchObject({ source: "bookmark" });
    });

    it("ignores entries that are not registrable domains", () => {
        const bad = new LookalikeIndex([
            { domain: "localhost", source: "bookmark" },
            { domain: "127.0.0.1", source: "bookmark" },
            { domain: "", source: "bookmark" },
            null as unknown as KnownDomain,
        ]);
        expect(bad.size()).toBe(0);
    });

    it("reads a known internationalized domain as text", () => {
        const idn = new LookalikeIndex(known("münchen.de"));
        expect(idn.knows("xn--mnchen-3ya.de")).toBe(true);
        expect(idn.find("munchen.de")).toMatchObject({ resembles: "xn--mnchen-3ya.de", reason: "skeleton" });
    });
});

describe("the bundled list (#2482)", () => {
    it("holds registrable ASCII domains only, once each", () => {
        const seen = new Set<string>();
        for (const domain of TopSites) {
            expect(registrableDomain(domain), domain).toBe(domain);
            expect(domain).toMatch(/^[a-z0-9.-]+$/);
            expect(seen.has(domain), `${domain} twice`).toBe(false);
            seen.add(domain);
        }
        expect(topSiteDomains()).toHaveLength(TopSites.length);
    });

    it("catches the usual typosquats of its services and none of its own entries", () => {
        const index = new LookalikeIndex(topSiteDomains());
        for (const typo of [
            "paypa1.com",
            "gooogle.com",
            "arnazon.com",
            "micr0soft.com",
            "githud.com",
            "linkedln.com",
            "faceb00k.com",
        ]) {
            expect(index.find(typo), typo).not.toBeNull();
        }
        for (const domain of TopSites) {
            expect(index.find(domain), domain).toBeNull();
        }
    });
});

describe("how a host is shown (#2482)", () => {
    it("keeps an ASCII host as it is", () => {
        expect(shownHost("login.example.com")).toBe("login.example.com");
        expect(shownHost("EXAMPLE.com")).toBe("example.com");
    });

    it("shows a host in one script as text", () => {
        expect(shownHost("xn--mnchen-3ya.de")).toBe("münchen.de");
        expect(shownHost("日本語.jp")).toBe("日本語.jp");
        expect(shownHost("xn--wgv71a119e.jp")).toBe("日本語.jp");
        expect(shownHost("пример.рф")).toBe("пример.рф");
    });

    it("shows a host whose label mixes scripts in its xn-- form", () => {
        const mixed = asciiHost("pаypal.com");
        expect(mixed.startsWith("xn--")).toBe(true);
        expect(shownHost("pаypal.com")).toBe(mixed);
        expect(shownHost(mixed)).toBe(mixed);
        expect(shownHost("www.exаmple.com")).toBe(asciiHost("www.exаmple.com"));
    });

    it("lets Han combine with the scripts it is written with", () => {
        expect(labelMixesScripts("日本語のひらがなカタカナ")).toBe(false);
        expect(labelMixesScripts("中文ㄅㄆ")).toBe(false);
        expect(labelMixesScripts("한국어漢字")).toBe(false);
        expect(labelMixesScripts("日本語abc")).toBe(true);
        expect(labelMixesScripts("abc-123")).toBe(false);
        expect(labelMixesScripts("раураl")).toBe(true);
    });

    it("shows a flagged host in its xn-- form even in one script", () => {
        const host = asciiHost("аррӏе.com");
        expect(shownHost(host, true)).toBe(host);
        expect(shownHost(host, false)).toBe(unicodeHost(host));
    });

    it("rewrites the host of a web address and keeps the rest", () => {
        const mixed = asciiHost("pаypal.com");
        expect(shownAddressHost(`https://${mixed}/signin?a=1#top`)).toBe(`https://${mixed}/signin?a=1#top`);
        expect(shownAddressHost("https://xn--mnchen-3ya.de:8443/a")).toBe("https://münchen.de:8443/a");
        expect(shownAddressHost("https://user:pw@xn--mnchen-3ya.de/a")).toBe("https://user:pw@münchen.de/a");
        expect(shownAddressHost("https://pаypal.com/x")).toBe(`https://${mixed}/x`);
        expect(shownAddressHost("https://example.com/a")).toBe("https://example.com/a");
        expect(shownAddressHost("http://[::1]:3000/")).toBe("http://[::1]:3000/");
        expect(shownAddressHost("about:blank")).toBe("about:blank");
        expect(shownAddressHost("file:///tmp/münchen")).toBe("file:///tmp/münchen");
        expect(shownAddressHost(undefined as unknown as string)).toBeUndefined();
    });
});

describe("what sets a lookalike apart (#2482)", () => {
    it("names a digit that stands for a letter", () => {
        expect(describeDifference("paypa1.com", "paypal.com")).toEqual({ kind: "digit", vars: { from: "1", to: "l" } });
        expect(describeDifference("g00gle.com", "google.com").kind).toBe("substitute");
        expect(describeDifference("micr0soft.com", "microsoft.com")).toEqual({
            kind: "digit",
            vars: { from: "0", to: "o" },
        });
    });

    it("names a letter of another script", () => {
        expect(describeDifference(asciiHost("pаypal.com"), "paypal.com")).toEqual({
            kind: "script",
            vars: { script: "Cyrillic", from: "а", to: "a" },
        });
        expect(describeDifference(asciiHost("gοogle.com"), "google.com")).toMatchObject({
            kind: "script",
            vars: { script: "Greek" },
        });
    });

    it("names a letter more, a letter less and two letters swapped", () => {
        expect(describeDifference("gooogle.com", "google.com")).toEqual({ kind: "extra", vars: { char: "o" } });
        expect(describeDifference("gogle.com", "google.com")).toEqual({ kind: "missing", vars: { char: "o" } });
        expect(describeDifference("googel.com", "google.com")).toEqual({ kind: "swapped", vars: { pair: "el" } });
    });

    it("names a short substitution, a letter pair read as one included", () => {
        expect(describeDifference("goagle.com", "google.com")).toEqual({
            kind: "substitute",
            vars: { from: "a", to: "o" },
        });
        expect(describeDifference("arnazon.com", "amazon.com")).toEqual({
            kind: "substitute",
            vars: { from: "rn", to: "m" },
        });
    });

    it("says nothing precise when the domains differ in several places", () => {
        expect(describeDifference("pa1pa1.com", "paypal.com")).toEqual({ kind: "generic", vars: {} });
        expect(describeDifference("paypal.com", "paypal.com")).toEqual({ kind: "generic", vars: {} });
    });
});

describe("what the window and main exchange (#2482)", () => {
    it("reduces the addresses the window sends to bounded registrable domains", () => {
        const addresses = [
            "https://login.paypal.com/a",
            "https://paypal.com/b",
            "http://localhost:3000",
            "file:///x",
            "ftp://x.org",
            "javascript:1",
            "https://" + "a".repeat(3000) + ".com",
        ];
        expect(knownDomainsFrom(addresses, "pinned")).toEqual([{ domain: "paypal.com", source: "pinned" }]);
        expect(knownDomainsFrom([...addresses, 42], "pinned")).toEqual([]);
        expect(knownDomainsFrom("https://paypal.com", "pinned")).toEqual([]);
        expect(knownDomainsFrom(null, "pinned")).toEqual([]);
        const many = Array.from({ length: 5000 }, (_, i) => `https://site${i}.com/`);
        expect(knownDomainsFrom(many, "bookmark").length).toBe(2000);
    });

    it("accepts the shape of a hold and nothing else", () => {
        const hold = {
            url: "u",
            host: "h",
            domain: "d",
            resembles: "r",
            source: "top",
            reason: "skeleton",
            agent: false,
        };
        expect(isLookalikeHold(hold)).toBe(true);
        for (const value of [null, undefined, "x", {}, { ...hold, agent: "no" }, { ...hold, url: 1 }]) {
            expect(isLookalikeHold(value), JSON.stringify(value)).toBe(false);
        }
    });
});
