// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { anchoredMenuEvent, buttonMenuAnchor } from "./menu-anchor";
import { menuOpenedByKeyboard, menuPoint } from "./menu-model";

describe("a button's menu opens at the button (#1439)", () => {
    const anchor = { left: 412, bottom: 38 };

    it("puts a keyboard opening (Enter or Space: a click at 0, 0) under the button and keeps the keyboard focus", () => {
        const click = { type: "click", detail: 0, clientX: 0, clientY: 0 };
        const event = anchoredMenuEvent(click, anchor);
        expect(menuPoint(event)).toEqual({ x: 412, y: 38 });
        expect(menuOpenedByKeyboard(event, false)).toBe(true);
    });

    it("puts a script click under the button too, and a pointer opening stays a pointer opening", () => {
        const scripted = anchoredMenuEvent({ type: "click", detail: 1, clientX: 0, clientY: 0 }, anchor);
        expect(menuPoint(scripted)).toEqual({ x: 412, y: 38 });
        expect(menuOpenedByKeyboard(scripted, false)).toBe(false);
    });

    it("keeps the event's methods working on the original event", () => {
        let stopped = 0;
        const event = {
            clientX: 0,
            clientY: 0,
            stopPropagation() {
                stopped++;
            },
        };
        anchoredMenuEvent(event, anchor).stopPropagation();
        expect(stopped).toBe(1);
        expect(event.clientX).toBe(0);
    });

    it("works on a native event, whose getters refuse any other receiver", () => {
        class NativeLike {
            #type = "click";
            get type() {
                return this.#type;
            }
            get detail() {
                return 0;
            }
            get altKey() {
                return false;
            }
            stopPropagation() {
                return this.#type;
            }
        }
        const event = anchoredMenuEvent(new NativeLike(), anchor);
        expect(event.type).toBe("click");
        expect(() => event.stopPropagation()).not.toThrow();
        expect(menuOpenedByKeyboard(event, false)).toBe(true);
        expect(menuPoint(event as object)).toEqual({ x: 412, y: 38 });
    });

    it("reads the anchor from the button's rectangle", () => {
        const button = {
            closest: () => button,
            getBoundingClientRect: () => ({ left: 100, bottom: 30 }),
        } as unknown as Element;
        expect(buttonMenuAnchor(button)).toEqual({ left: 100, bottom: 30 });
    });
});
