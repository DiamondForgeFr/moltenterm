// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PageAddressFrame, type PageAddressCopy } from "./page-address-frame";

const Idle: PageAddressCopy = { copied: false, copyLabel: "Copy link", copiedLabel: "Link copied", onCopy: () => {} };
const Copied: PageAddressCopy = { ...Idle, copied: true };

const Address = (
    <button type="button" data-testid="browser-address" className="min-w-0 flex-1">
        <span className="truncate">example.com</span>
    </button>
);

function render(copy: PageAddressCopy): string {
    return renderToStaticMarkup(<PageAddressFrame copy={copy}>{Address}</PageAddressFrame>);
}

function openingTag(html: string, testId: string): string {
    const found = new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`).exec(html);
    expect(found, `a tag with data-testid="${testId}"`).not.toBeNull();
    return found[0];
}

function classesOf(tag: string): string[] {
    return /class="([^"]*)"/.exec(tag)[1].split(/\s+/);
}

function wrapperClasses(html: string): string[] {
    return classesOf(/^<div [^>]*>/.exec(html)[0]);
}

function findByTestId(node: ReactNode, testId: string): ReactElement<Record<string, unknown>> {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findByTestId(child, testId);
            if (found != null) {
                return found;
            }
        }
        return null;
    }
    if (!isValidElement<Record<string, unknown>>(node)) {
        return null;
    }
    if (node.props["data-testid"] === testId) {
        return node;
    }
    return findByTestId(node.props.children as ReactNode, testId);
}

describe("the page address and its Copy link button (FR-SHELL-051, #2322)", () => {
    it("puts the copy button right after the address button, not inside it", () => {
        const html = render(Idle);
        const addressStart = html.indexOf('data-testid="browser-address"');
        const addressEnd = html.indexOf("</button>", addressStart) + "</button>".length;
        const copyStart = html.indexOf("<button", addressEnd);
        expect(addressStart).toBeGreaterThan(0);
        expect(html.slice(addressStart, addressEnd)).not.toContain("browser-address-copy");
        expect(html.slice(addressEnd, copyStart)).toBe("");
        expect(html.slice(copyStart)).toContain('data-testid="browser-address-copy"');
    });

    it("never lays the copy button over the address", () => {
        const html = render(Idle);
        const positioned = /^(absolute|fixed|relative|sticky|-?(inset|top|right|bottom|left)(-|$))/;
        expect(classesOf(openingTag(html, "browser-address-copy")).filter((c) => positioned.test(c))).toEqual([]);
        expect(wrapperClasses(html).filter((c) => positioned.test(c))).toEqual([]);
    });

    it("reserves the slot while the button is hidden and reveals it by opacity only", () => {
        const classes = classesOf(openingTag(render(Idle), "browser-address-copy"));
        expect(classes).toEqual(expect.arrayContaining(["shrink-0", "w-6", "h-6", "opacity-0", "pointer-events-none"]));
        expect(classes).not.toEqual(expect.arrayContaining(["hidden"]));
        expect(classes.filter((c) => c.startsWith("group-hover:"))).toEqual([
            "group-hover:pointer-events-auto",
            "group-hover:opacity-100",
        ]);
        expect(classes.filter((c) => c.startsWith("group-focus-within:"))).toEqual([
            "group-focus-within:pointer-events-auto",
            "group-focus-within:opacity-100",
        ]);
        expect(wrapperClasses(render(Idle))).toContain("group");
    });

    it("lets the address shrink first and keeps the copy slot", () => {
        const html = render(Idle);
        expect(wrapperClasses(html)).toEqual(expect.arrayContaining(["min-w-0", "shrink"]));
        const slot = classesOf(openingTag(html, "browser-address-copy"));
        expect(slot).toContain("shrink-0");
        expect(slot.some((c) => /^(flex-1|grow|flex-auto)$/.test(c))).toBe(false);
    });

    it("shows Link copied beside a check for a moment, and announces it", () => {
        const idle = render(Idle);
        expect(openingTag(idle, "browser-address-copy")).toContain('data-copied="false"');
        expect(openingTag(idle, "browser-address-copy")).toContain('aria-label="Copy link"');
        expect(idle).toContain("fa-copy");
        expect(idle).not.toContain("Link copied");

        const copied = render(Copied);
        const tag = openingTag(copied, "browser-address-copy");
        expect(tag).toContain('data-copied="true"');
        expect(tag).toContain('aria-label="Link copied"');
        expect(classesOf(tag)).toEqual(expect.arrayContaining(["opacity-100", "min-w-6"]));
        expect(copied).toContain("fa-check");
        expect(copied).toContain("<span>Link copied</span>");
        expect(copied).toContain('role="status"');
    });

    it("has no copy button for a page without an address", () => {
        const html = renderToStaticMarkup(<PageAddressFrame copy={null}>{Address}</PageAddressFrame>);
        expect(html).not.toContain("browser-address-copy");
        expect(html).toContain('data-testid="browser-address"');
    });

    it("copies from the icon only: the frame itself takes no click", () => {
        const onCopy = vi.fn();
        const tree = PageAddressFrame({ copy: { ...Idle, onCopy }, children: Address }) as ReactElement<
            Record<string, unknown>
        >;
        expect(tree.props.onClick).toBeUndefined();
        const button = findByTestId(tree, "browser-address-copy");
        expect(button).not.toBeNull();
        (button.props.onClick as () => void)();
        expect(onCopy).toHaveBeenCalledTimes(1);
        const address = findByTestId(tree, "browser-address");
        expect(address.props.onClick).toBeUndefined();
        expect(findByTestId(address.props.children as ReactNode, "browser-address-copy")).toBeNull();
    });
});
