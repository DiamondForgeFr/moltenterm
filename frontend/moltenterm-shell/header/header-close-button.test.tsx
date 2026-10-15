// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeaderCloseButton } from "./header-close-button";

const headerTsx = readFileSync(new URL("../../app/block/blockframe-header.tsx", import.meta.url), "utf8");
const browserTsx = readFileSync(new URL("../browser/browser-view.tsx", import.meta.url), "utf8");

describe("HeaderCloseButton (#705)", () => {
    it("draws the close button while the panel sits in the layout", () => {
        const html = renderToStaticMarkup(
            <HeaderCloseButton magnified={false} onClose={() => {}} className="block-frame-default-close" />
        );
        expect(html).toMatch(/^<button/);
        expect(html).toContain("fa-xmark-large");
        expect(html).toContain("block-frame-default-close");
        expect(html).not.toContain("header-close-placeholder");
    });

    it("draws no button while magnified, only an inert placeholder keeping the slot", () => {
        const html = renderToStaticMarkup(
            <HeaderCloseButton magnified={true} onClose={() => {}} className="block-frame-default-close" />
        );
        expect(html).not.toContain("<button");
        expect(html).toContain('data-testid="header-close-placeholder"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain("invisible");
        expect(html).toContain("pointer-events-none");
        // Same box as the button, so un-magnify keeps its place.
        expect(html).toContain("wave-iconbutton");
        expect(html).toContain("block-frame-default-close");
    });

    it("is the close button of every header, the browser panel's own included", () => {
        expect(headerTsx).toContain("<HeaderCloseButton");
        expect(headerTsx).toMatch(/magnified=\{magnified\}\s+onClose=/);
        expect(browserTsx).toContain("<HeaderCloseButton magnified={magnified}");
        expect(headerTsx).not.toMatch(/icon: "xmark-large"/);
        expect(browserTsx).not.toMatch(/icon: "xmark-large"/);
    });
});
