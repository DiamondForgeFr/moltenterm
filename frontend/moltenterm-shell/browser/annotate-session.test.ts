// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import { AnnotateSession } from "./annotate-session";

describe("the annotate session of a panel (#2327)", () => {
    it("starts on a page of the web, once, and each start is a new session", () => {
        const session = new AnnotateSession();
        expect(session.isOpen()).toBe(false);
        expect(session.start("tab-1", "http://localhost:5173/")).toBe(true);
        expect(globalStore.get(session.openAtom)).toMatchObject({
            tabId: "tab-1",
            url: "http://localhost:5173/",
            nonce: 1,
        });
        expect(session.start("tab-1", "http://localhost:5173/")).toBe(false);
        session.close();
        expect(session.isOpen()).toBe(false);
        expect(session.start("tab-1", "https://example.test/")).toBe(true);
        expect(globalStore.get(session.openAtom).nonce).toBe(2);
    });

    it("does not start on a page that is no page of the web", () => {
        const session = new AnnotateSession();
        for (const url of ["", "about:blank", "file:///etc/hosts", "data:text/html,x"]) {
            expect(session.start("tab-1", url)).toBe(false);
        }
        expect(session.isOpen()).toBe(false);
    });

    it("keeps the sessions of two panels apart", () => {
        const a = new AnnotateSession();
        const b = new AnnotateSession();
        a.start("tab-a", "http://localhost:1/");
        expect(b.isOpen()).toBe(false);
    });
});
