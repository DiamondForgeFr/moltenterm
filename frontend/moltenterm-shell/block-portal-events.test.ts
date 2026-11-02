// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cameThroughPortal } from "./block-portal-events";

// A DOM tree in miniature: contains() walks the parents, as Node.contains does.
type FakeNode = { parent: FakeNode; contains: (other: Node) => boolean };
function node(parent: FakeNode = null): FakeNode {
    const self: FakeNode = {
        parent,
        contains: (other) => {
            for (let n = other as unknown as FakeNode; n != null; n = n.parent) {
                if (n === self) {
                    return true;
                }
            }
            return false;
        },
    };
    return self;
}
const asTarget = (n: FakeNode) => ({ target: n as unknown as EventTarget });

describe("a dialog's events reaching the block that opened it (#1070)", () => {
    const body = node();
    const block = node(body);
    const select = node(node(block));
    const dialog = node(body);
    const dialogSelect = node(node(dialog));

    it("tells a click in a portal from a click in the block", () => {
        expect(cameThroughPortal(asTarget(select), block)).toBe(false);
        expect(cameThroughPortal(asTarget(block), block)).toBe(false);
        expect(cameThroughPortal(asTarget(dialogSelect), block)).toBe(true);
    });

    it("keeps the block's behaviour when it cannot tell", () => {
        expect(cameThroughPortal(asTarget(dialogSelect), null)).toBe(false);
        expect(cameThroughPortal({ target: null }, block)).toBe(false);
    });

    // The handlers are Wave's (block.tsx): without the check, a click or a focus in the merged history's filters makes
    // the block focus its hidden input and the select's popup closes at once.
    it("guards the block's click and child-focus handlers", () => {
        const source = fs.readFileSync(path.join(__dirname, "../app/block/block.tsx"), "utf8");
        const handler = (name: string) => {
            const start = source.indexOf(`const ${name} = useCallback(`);
            expect(start).toBeGreaterThan(0);
            return source.slice(start, source.indexOf("\n\n", start));
        };
        expect(handler("setBlockClickedTrue")).toContain("cameThroughPortal(event, blockRef.current)");
        expect(handler("handleChildFocus")).toContain("cameThroughPortal(event, blockRef.current)");
    });
});
