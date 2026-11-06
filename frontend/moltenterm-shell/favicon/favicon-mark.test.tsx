// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A site's icon wherever a bookmark is listed or edited (#1962, FR-BRW-019 AC11): the bookmark dialog's address field and
// Settings › Browser's rows draw the icon kept for the address's origin, the generic web icon otherwise.

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AddressIcon, FaviconMark, GenericWebMark } from "./favicon-mark";
import { faviconsAtom, resetFaviconCacheForTest } from "./favicon-store";

const Icon = "data:image/png;base64,U1RBR0lORw==";

function render(node: React.ReactNode) {
    return renderToStaticMarkup(<Provider store={globalStore}>{node}</Provider>);
}

beforeEach(() => {
    resetFaviconCacheForTest();
});

describe("the icon of an address", () => {
    it("is the icon kept for its origin, whatever the page of that origin", () => {
        globalStore.set(faviconsAtom, { "https://staging.example.com": { url: Icon } });
        for (const address of ["https://staging.example.com/", "https://staging.example.com/d/abc?x=1#y"]) {
            const html = render(<AddressIcon address={address} />);
            expect(html).toContain("<img");
            expect(html).toContain(`src="${Icon}"`);
            expect(html).not.toContain("fa-globe");
        }
    });

    it("is the generic web icon for a site that was never visited, an unknown or a typed-in half address", () => {
        globalStore.set(faviconsAtom, { "https://staging.example.com": { url: Icon } });
        for (const address of ["https://never-visited.test/", "", "staging", "https://"]) {
            const html = render(<AddressIcon address={address} />);
            expect(html).not.toContain("<img");
            expect(html).toContain("fa-globe");
        }
    });

    it("sits on a plate when the icon was measured too dark, and never otherwise", () => {
        globalStore.set(faviconsAtom, {
            "https://dark.test": { url: Icon, dark: true },
            "https://light.test": { url: Icon, dark: false },
        });
        expect(render(<AddressIcon address="https://dark.test/" />)).toContain("is-dark");
        expect(render(<AddressIcon address="https://light.test/" />)).not.toContain("is-dark");
    });

    it("is only an image of the address it was given, never markup", () => {
        const svg = "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+";
        const html = render(<FaviconMark url={svg} />);
        expect(html).toContain("<img");
        expect(html).not.toContain("<script");
        expect(render(<GenericWebMark />)).toContain("fa-globe");
    });
});
