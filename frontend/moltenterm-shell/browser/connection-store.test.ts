// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import type { ConnectionState } from "./connection-security";
import { ConnectionModel, connectionView, LookalikeModel } from "./connection-store";
import type { LookalikeHold } from "./lookalike";

const state = (url: string, mixed = false): ConnectionState => ({ url, mixed, certificate: null });
const hold: LookalikeHold = {
    url: "https://paypa1.com/",
    host: "paypa1.com",
    domain: "paypa1.com",
    resembles: "paypal.com",
    source: "top",
    reason: "skeleton",
    agent: false,
};

describe("what the button beside the address shows (#1980, #2482)", () => {
    const view = (address: string, s: ConnectionState | null, held: LookalikeHold | null = null, failed = false) =>
        connectionView({ address, state: s, held, failed });

    it("is a lock for a secure page main has seen", () => {
        expect(view("https://a.example/", state("https://a.example/"))).toEqual({ kind: "secure" });
    });

    it("is nothing for an https page main has not reported yet: a lock is never guessed", () => {
        expect(view("https://a.example/", null)).toBeNull();
    });

    it("is a warning for plain http outside the local machine, even before main reports", () => {
        expect(view("http://a.example/", state("http://a.example/"))).toEqual({ kind: "insecure" });
        expect(view("http://a.example/", null)).toEqual({ kind: "insecure" });
    });

    it("is partly secure for https with insecure content", () => {
        expect(view("https://a.example/", state("https://a.example/", true))).toEqual({ kind: "mixed" });
    });

    it("is nothing for a local page, a page that is not a web page, or a page that failed to load", () => {
        expect(view("http://localhost:3000/", state("http://localhost:3000/"))).toBeNull();
        expect(view("about:blank", state("about:blank"))).toBeNull();
        expect(view("https://a.example/", state("chrome-error://chromewebdata/"))).toBeNull();
        expect(view("https://a.example/", state("https://a.example/"), null, true)).toBeNull();
    });

    it("is the suspect state while a navigation is held, whatever the old page was", () => {
        expect(view("https://paypa1.com/", state("https://a.example/"), hold)).toEqual({ kind: "suspect" });
        expect(view("https://paypa1.com/", null, hold, true)).toEqual({ kind: "suspect" });
    });

    it("follows the page main reports over what the tab typed", () => {
        expect(view("https://typed.example/", state("http://committed.example/"))).toEqual({ kind: "insecure" });
    });
});

describe("the password warning (#1980)", () => {
    it("shows for the page whose password field took the focus, on plain http outside the local machine", () => {
        const model = new ConnectionModel();
        model.notePasswordField("t1", "http://a.example/login");
        expect(model.warningFor("t1", "http://a.example/login")).toBe("http://a.example/login");
        expect(model.warningFor("t2", "http://a.example/login")).toBeNull();
    });

    it("never shows on https, a local page or a page that is not a web page", () => {
        const model = new ConnectionModel();
        for (const address of [
            "https://a.example/login",
            "http://localhost:3000/login",
            "http://127.0.0.1/",
            "about:blank",
            "file:///x.html",
        ]) {
            model.notePasswordField("t1", address);
            expect(model.warningFor("t1", address), address).toBeNull();
        }
    });

    it("is for that page only: it goes when the tab moves to another page", () => {
        const model = new ConnectionModel();
        model.notePasswordField("t1", "http://a.example/login");
        expect(model.warningFor("t1", "http://a.example/login#again")).toBe("http://a.example/login");
        expect(model.warningFor("t1", "http://a.example/other")).toBeNull();
        expect(model.warningFor("t1", "https://a.example/login")).toBeNull();
    });

    it("stays dismissed for that page and comes back on the next one", () => {
        const model = new ConnectionModel();
        model.notePasswordField("t1", "http://a.example/login");
        model.dismissWarning("t1");
        expect(model.warningFor("t1", "http://a.example/login")).toBeNull();
        model.notePasswordField("t1", "http://a.example/login");
        expect(model.warningFor("t1", "http://a.example/login")).toBeNull();
        model.notePasswordField("t1", "http://a.example/signup");
        expect(model.warningFor("t1", "http://a.example/signup")).toBe("http://a.example/signup");
    });

    it("keeps nothing for a tab that closed", () => {
        const model = new ConnectionModel();
        model.setState("t1", state("http://a.example/"));
        model.notePasswordField("t1", "http://a.example/login");
        model.forgetTab("t1");
        expect(model.stateOf("t1")).toBeNull();
        expect(model.warningFor("t1", "http://a.example/login")).toBeNull();
        expect(globalStore.get(model.warningsAtom)).toEqual({});
    });
});

describe("the navigations held per tab (#2482)", () => {
    it("holds one per tab and clears it", () => {
        const model = new LookalikeModel();
        model.hold("t1", hold);
        expect(model.holdOf("t1")).toEqual(hold);
        expect(model.holdOf("t2")).toBeNull();
        model.clear("t1");
        model.clear("t1");
        expect(model.holdOf("t1")).toBeNull();
    });
});
