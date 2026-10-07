// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RailEditButton } from "./workspace-rail-edit";

describe("rail pencil (FR-SHELL-030-AC1)", () => {
    const html = renderToStaticMarkup(
        <RailEditButton name="Client A" onEdit={() => {}} onHover={() => {}} onLeave={() => {}} />
    );

    it("is a real button named after the workspace", () => {
        expect(html).toMatch(/^<button type="button" aria-label="Edit Client A"/);
        expect(html).not.toContain("tabindex");
    });

    it("shows on hover and on keyboard focus of the item, hidden otherwise", () => {
        expect(html).toContain("opacity-0");
        expect(html).toContain("group-hover:opacity-100");
        expect(html).toContain("group-focus-within:opacity-100");
        expect(html).toContain("focus-visible:opacity-100");
        expect(html).toContain("motion-reduce:transition-none");
    });

    it("has a 24 px target and a pointer cursor", () => {
        expect(html).toContain("h-6 w-6");
        expect(html).toContain("cursor-pointer");
        expect(html).not.toContain("cursor-help");
    });
});
