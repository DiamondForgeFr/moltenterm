// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    armOnPointerLeave,
    closeAllowed,
    HeaderCloseButton,
    noteMagnifiedChange,
    UnmagnifyGuard,
    UnmagnifyGuardMs,
} from "./header-close-button";

const headerTsx = readFileSync(new URL("../../app/block/blockframe-header.tsx", import.meta.url), "utf8");
const browserTsx = readFileSync(new URL("../browser/browser-view.tsx", import.meta.url), "utf8");

describe("HeaderCloseButton (#705, #939)", () => {
    it("draws the close button while the panel sits in the layout", () => {
        const html = renderToStaticMarkup(
            <HeaderCloseButton magnified={false} onClose={() => {}} className="block-frame-default-close" />
        );
        expect(html).toMatch(/^<span class="contents"><button/);
        expect(html).toContain("fa-xmark-large");
        expect(html).toContain("block-frame-default-close");
        expect(html).not.toContain("header-close-placeholder");
    });

    it("draws nothing while magnified, no slot, so un-magnify ends the row flush right (#939)", () => {
        const html = renderToStaticMarkup(
            <HeaderCloseButton magnified={true} onClose={() => {}} className="block-frame-default-close" />
        );
        expect(html).toBe("");
    });

    it("keeps un-magnify right before the close button, so it is the right-most icon only while magnified", () => {
        const magnifyAt = headerTsx.indexOf("<OptMagnifyButton");
        const closeAt = headerTsx.indexOf("<HeaderCloseButton");
        expect(magnifyAt).toBeGreaterThan(0);
        expect(closeAt).toBeGreaterThan(magnifyAt);
        expect(headerTsx.slice(magnifyAt, closeAt)).not.toContain("endIconsElem.push(<");
        expect(browserTsx.indexOf("<OptMagnifyButton")).toBeLessThan(browserTsx.indexOf("<HeaderCloseButton"));
    });

    it("ignores a click on the × right after un-magnify until the pointer leaves it (#939)", () => {
        const guard: UnmagnifyGuard = { disarmedUntil: 0 };
        expect(closeAllowed(guard, 5000)).toBe(true);

        noteMagnifiedChange(guard, false, true, 5000);
        expect(closeAllowed(guard, 5000)).toBe(true);

        noteMagnifiedChange(guard, true, false, 10000);
        expect(closeAllowed(guard, 10000)).toBe(false);
        expect(closeAllowed(guard, 10000 + UnmagnifyGuardMs - 1)).toBe(false);
        expect(closeAllowed(guard, 10000 + UnmagnifyGuardMs)).toBe(true);

        noteMagnifiedChange(guard, true, false, 20000);
        armOnPointerLeave(guard);
        expect(closeAllowed(guard, 20000)).toBe(true);
    });

    it("is the close button of every header, the browser panel's own included", () => {
        expect(headerTsx).toContain("<HeaderCloseButton");
        expect(headerTsx).toMatch(/magnified=\{magnified\}\s+onClose=/);
        expect(browserTsx).toContain("<HeaderCloseButton magnified={magnified}");
        expect(headerTsx).not.toMatch(/icon: "xmark-large"/);
        expect(browserTsx).not.toMatch(/icon: "xmark-large"/);
    });
});
