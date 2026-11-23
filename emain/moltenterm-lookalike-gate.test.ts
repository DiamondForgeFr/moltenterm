// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LookalikeGate } from "./moltenterm-lookalike-gate";
import { LookalikeStore } from "./moltenterm-lookalike-store";

let dir: string;
let store: LookalikeStore;
let gate: LookalikeGate;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-lookalike-gate-"));
    store = new LookalikeStore(dir);
    gate = new LookalikeGate(store, [
        { domain: "paypal.com", source: "top" },
        { domain: "google.com", source: "top" },
    ]);
});

afterEach(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the navigations the gate holds (#2482)", () => {
    it("holds a domain that imitates a known one, with what the warning shows", () => {
        const hold = gate.check(1, "https://paypa1.com/signin?x=1");
        expect(hold).toEqual({
            url: "https://paypa1.com/signin?x=1",
            host: "paypa1.com",
            domain: "paypa1.com",
            resembles: "paypal.com",
            source: "top",
            reason: "skeleton",
            agent: false,
        });
        expect(gate.holdOf(1)).toEqual(hold);
        expect(gate.holdOf(2)).toBeNull();
    });

    it("spells an internationalized lookalike in its xn-- form", () => {
        const hold = gate.check(1, "https://pаypal.com/");
        expect(hold.host).toMatch(/^xn--/);
        expect(hold.resembles).toBe("paypal.com");
    });

    it("lets everything else go: the known domain, its subdomains, other schemes, other names", () => {
        for (const address of [
            "https://paypal.com/",
            "https://login.paypal.com/signin",
            "http://localhost:3000/",
            "http://127.0.0.1:8080/",
            "https://example.org/",
            "https://intranet/",
            "about:blank",
            "file:///tmp/a.html",
            "javascript:alert(1)",
            "not an address",
            "",
        ]) {
            expect(gate.check(1, address), address).toBeNull();
        }
        expect(gate.holdOf(1)).toBeNull();
    });

    it("compares with the bookmarks and the pinned sites the window sends", () => {
        gate.setKnown(["https://example-shop.com/cart"], ["https://ledger-app.io/"]);
        expect(gate.check(1, "https://example-shqp.com/")).toMatchObject({
            resembles: "example-shop.com",
            source: "bookmark",
        });
        expect(gate.check(1, "https://ledger-aqp.io/")).toMatchObject({ resembles: "ledger-app.io", source: "pinned" });
    });

    it("ignores what the window sends that is not a list of addresses", () => {
        gate.setKnown("https://example-shop.com", { a: 1 });
        expect(gate.check(1, "https://example-shqp.com/")).toBeNull();
        gate.setKnown(null, undefined);
        expect(gate.check(1, "https://paypa1.com/")).not.toBeNull();
    });

    it("compares with the domains opened often", () => {
        for (let i = 0; i < 3; i++) {
            gate.noteCommitted(10 + i, "https://frequent-site.dev/page", false);
        }
        expect(gate.check(1, "https://frequent-sitf.dev/")).toMatchObject({
            resembles: "frequent-site.dev",
            source: "frequent",
        });
    });

    it("does not hold a domain the developer continued to", () => {
        expect(gate.check(1, "https://paypa1.com/")).not.toBeNull();
        expect(gate.continueTo(1)).toMatchObject({ domain: "paypa1.com" });
        expect(gate.holdOf(1)).toBeNull();
        expect(gate.check(1, "https://paypa1.com/other")).toBeNull();
        expect(gate.check(2, "https://login.paypa1.com/")).toBeNull();
        expect(gate.check(1, "https://paypa11.com/")).not.toBeNull();
        expect(new LookalikeStore(dir).isAllowed("paypa1.com")).toBe(false);
        store.flush();
        expect(new LookalikeStore(dir).isAllowed("paypa1.com")).toBe(true);
    });

    it("continues only what is held for that guest", () => {
        gate.check(1, "https://paypa1.com/");
        expect(gate.continueTo(2)).toBeNull();
        expect(gate.check(2, "https://paypa1.com/")).not.toBeNull();
        expect(store.isAllowed("paypa1.com")).toBe(false);
    });
});

describe("an agent's navigation (#2482)", () => {
    it("is held like any other and labelled as the agent's", () => {
        gate.beginAgentNavigation(1);
        const hold = gate.check(1, "https://paypa1.com/");
        expect(hold.agent).toBe(true);
        expect(gate.agentWasHeld(1)).toBe(true);
        gate.endAgentNavigation(1);
        expect(gate.check(2, "https://gooogle.com/").agent).toBe(false);
        expect(gate.agentWasHeld(2)).toBe(false);
    });

    it("starts with no hold left from an earlier attempt", () => {
        gate.check(1, "https://paypa1.com/");
        gate.beginAgentNavigation(1);
        expect(gate.holdOf(1)).toBeNull();
        expect(gate.agentWasHeld(1)).toBe(false);
    });

    it("cannot pass the warning by itself: only the developer's continue records the domain", () => {
        gate.beginAgentNavigation(1);
        gate.check(1, "https://paypa1.com/");
        gate.endAgentNavigation(1);
        gate.beginAgentNavigation(1);
        expect(gate.check(1, "https://paypa1.com/")).not.toBeNull();
        expect(store.isAllowed("paypa1.com")).toBe(false);
    });

    it("opens a domain the developer already continued to", () => {
        gate.check(1, "https://paypa1.com/");
        gate.continueTo(1);
        gate.beginAgentNavigation(2);
        expect(gate.check(2, "https://paypa1.com/")).toBeNull();
    });

    it("never adds to the domains opened often", () => {
        gate.beginAgentNavigation(1);
        for (let i = 0; i < 5; i++) {
            gate.noteCommitted(1, `https://agent-led.dev/${i}`, false);
            gate.noteCommitted(1, "https://elsewhere.dev/", false);
        }
        gate.endAgentNavigation(1);
        for (let i = 0; i < 5; i++) {
            gate.noteCommitted(2, "https://controlled.dev/", true);
            gate.noteCommitted(2, "https://elsewhere.dev/", true);
        }
        expect(store.frequent()).toEqual([]);
    });
});

describe("the domains opened often (#2482)", () => {
    it("counts a visit when a guest enters a domain, not for each page of it", () => {
        for (let i = 0; i < 10; i++) {
            gate.noteCommitted(1, `https://site.dev/page${i}`, false);
        }
        expect(store.frequent()).toEqual([]);
        gate.noteCommitted(1, "https://other.dev/", false);
        gate.noteCommitted(1, "https://site.dev/", false);
        gate.noteCommitted(1, "https://other.dev/", false);
        gate.noteCommitted(1, "https://site.dev/", false);
        expect(store.frequent()).toEqual(["site.dev"]);
    });

    it("does not count a page that is not a web page, or a local one", () => {
        for (let i = 0; i < 6; i++) {
            gate.noteCommitted(1, "about:blank", false);
            gate.noteCommitted(1, "http://localhost:3000/", false);
            gate.noteCommitted(1, "file:///tmp/a.html", false);
        }
        expect(store.frequent()).toEqual([]);
    });

    it("ends a hold when the guest commits another page, and forgets a closed guest", () => {
        gate.check(1, "https://paypa1.com/");
        gate.noteCommitted(1, "https://example.org/", false);
        expect(gate.holdOf(1)).toBeNull();
        gate.check(2, "https://paypa1.com/");
        gate.forget(2);
        expect(gate.holdOf(2)).toBeNull();
    });
});
