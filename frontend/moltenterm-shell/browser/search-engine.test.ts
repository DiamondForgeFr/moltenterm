// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fieldResults } from "../sidebar/top-field-model";
import { addressUrl, toBrowserUrl } from "./browser-model";
import { DefaultSearchTemplate, searchUrl, webSearchTemplate } from "./search-engine";

vi.mock("@/app/store/global-atoms", async (importOriginal) => {
    const { atom } = await import("jotai");
    const original = await importOriginal<typeof import("@/app/store/global-atoms")>();
    return { ...original, atoms: { settingsAtom: atom({}) } };
});

const settings = () => atoms.settingsAtom as unknown as PrimitiveAtom<Record<string, unknown>>;
const setSearch = (template: string) => globalStore.set(settings(), { "web:defaultsearch": template });
const page = { onPage: true, pageHost: "docs.dev", viewName: "Build" };
const topFieldSearch = (words: string) => fieldResults(words, [], page, "Molten", true).flat[0].run;

describe("one search engine everywhere, from web:defaultsearch (#1748)", () => {
    beforeEach(() => globalStore.set(settings(), {}));

    it("searches with the default engine while the setting is unset", () => {
        expect(webSearchTemplate()).toBeNull();
        expect(toBrowserUrl("some words")).toBe("https://www.google.com/search?q=some%20words");
        expect(topFieldSearch("some words")).toMatchObject({ url: "https://www.google.com/search?q=some%20words" });
    });

    it("the address bar and the top field follow the setting", () => {
        setSearch("https://duckduckgo.com/?q={query}");
        expect(toBrowserUrl("wave terminal")).toBe("https://duckduckgo.com/?q=wave%20terminal");
        expect(topFieldSearch("wave terminal")).toMatchObject({ url: "https://duckduckgo.com/?q=wave%20terminal" });
    });

    it("a setting change applies to the next search, without a restart", () => {
        setSearch("https://duckduckgo.com/?q={query}");
        expect(toBrowserUrl("a b")).toBe("https://duckduckgo.com/?q=a%20b");
        setSearch("https://www.bing.com/search?q={query}");
        expect(toBrowserUrl("a b")).toBe("https://www.bing.com/search?q=a%20b");
        expect(topFieldSearch("a b")).toMatchObject({ url: "https://www.bing.com/search?q=a%20b" });
        globalStore.set(settings(), {});
        expect(toBrowserUrl("a b")).toBe("https://www.google.com/search?q=a%20b");
    });

    it("an address is never searched, whatever the engine", () => {
        setSearch("https://duckduckgo.com/?q={query}");
        expect(toBrowserUrl("example.com?q=1")).toBe("https://example.com?q=1");
        expect(addressUrl("localhost:3000")).toBe("http://localhost:3000");
    });

    it("an unusable template falls back to the default engine", () => {
        for (const template of ["", "   ", "https://search.example/", null]) {
            setSearch(template);
            expect(toBrowserUrl("x y")).toBe("https://www.google.com/search?q=x%20y");
        }
    });
});

describe("searchUrl", () => {
    it("puts the encoded words at the {query} or %s placeholder", () => {
        expect(searchUrl("a&b c", "https://s.dev/?q={query}")).toBe("https://s.dev/?q=a%26b%20c");
        expect(searchUrl("a&b c", "https://s.dev/?q=%s")).toBe("https://s.dev/?q=a%26b%20c");
        expect(searchUrl("$& x", "https://s.dev/?q={query}&src={query}")).toBe(
            "https://s.dev/?q=%24%26%20x&src=%24%26%20x"
        );
    });

    it("uses the default template when given none", () => {
        expect(searchUrl("w", null)).toBe(DefaultSearchTemplate.replace("{query}", "w"));
    });
});
