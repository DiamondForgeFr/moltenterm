// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrequentVisits, LookalikeStore, MaxAllowed, MaxVisited } from "./moltenterm-lookalike-store";

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-lookalike-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function reopen(): LookalikeStore {
    return new LookalikeStore(dir);
}

describe("the domains the developer continued to (#2482)", () => {
    it("remembers a continued domain across a restart", () => {
        const store = new LookalikeStore(dir);
        expect(store.isAllowed("paypa1.com")).toBe(false);
        expect(store.allow("paypa1.com")).toBe(true);
        expect(store.isAllowed("paypa1.com")).toBe(true);
        store.flush();
        expect(reopen().isAllowed("paypa1.com")).toBe(true);
        expect(reopen().isAllowed("paypal.com")).toBe(false);
    });

    it("remembers registrable domains only, never an address or a subdomain", () => {
        const store = new LookalikeStore(dir);
        for (const bad of [
            "https://paypa1.com/login",
            "login.paypa1.com",
            "localhost",
            "127.0.0.1",
            "",
            "co.uk",
            undefined,
            42,
        ]) {
            expect(store.allow(bad as string), String(bad)).toBe(false);
        }
        store.flush();
        expect(fs.existsSync(path.join(dir, "lookalike-allowed.json"))).toBe(false);
    });

    it("keeps a bounded list, dropping the oldest", () => {
        const store = new LookalikeStore(dir);
        for (let i = 0; i <= MaxAllowed; i++) {
            store.allow(`site${i}.com`);
        }
        expect(store.isAllowed("site0.com")).toBe(false);
        expect(store.isAllowed("site1.com")).toBe(true);
        expect(store.isAllowed(`site${MaxAllowed}.com`)).toBe(true);
    });
});

describe("the domains opened often (#2482)", () => {
    it("becomes frequent at the third visit, once", () => {
        const store = new LookalikeStore(dir);
        const outcomes = Array.from({ length: FrequentVisits + 2 }, () => store.visit("frequent-site.dev"));
        expect(outcomes).toEqual([false, false, true, false, false]);
        expect(store.frequent()).toEqual(["frequent-site.dev"]);
    });

    it("does not list a domain opened fewer times", () => {
        const store = new LookalikeStore(dir);
        store.visit("once.com");
        store.visit("twice.com");
        store.visit("twice.com");
        expect(store.frequent()).toEqual([]);
    });

    it("keeps the counts across a restart", () => {
        const store = new LookalikeStore(dir);
        store.visit("frequent-site.dev");
        store.visit("frequent-site.dev");
        store.flush();
        const next = reopen();
        expect(next.frequent()).toEqual([]);
        expect(next.visit("frequent-site.dev")).toBe(true);
        expect(next.frequent()).toEqual(["frequent-site.dev"]);
    });

    it("never counts a domain the developer continued to a warning for", () => {
        const store = new LookalikeStore(dir);
        store.visit("passed.com");
        store.allow("passed.com");
        for (let i = 0; i < 5; i++) {
            expect(store.visit("passed.com")).toBe(false);
        }
        expect(store.frequent()).toEqual([]);
    });

    it("counts registrable domains only", () => {
        const store = new LookalikeStore(dir);
        for (const bad of ["https://example.com/a", "www.example.com", "localhost", "10.0.0.1", "", undefined]) {
            expect(store.visit(bad as string), String(bad)).toBe(false);
        }
        expect(store.frequent()).toEqual([]);
    });

    it("keeps a bounded number of domains, dropping the least visited first", () => {
        const store = new LookalikeStore(dir);
        for (let i = 0; i < 3; i++) {
            store.visit("favourite.com");
        }
        for (let i = 0; i < MaxVisited + 20; i++) {
            store.visit(`site${i}.com`);
        }
        expect(store.frequent()).toContain("favourite.com");
        store.flush();
        const saved = JSON.parse(fs.readFileSync(path.join(dir, "lookalike-visits.json"), "utf8"));
        expect(Object.keys(saved).length).toBeLessThanOrEqual(MaxVisited);
    });
});

describe("what is written (#2482)", () => {
    it("holds domains and counts only, privately", () => {
        const store = new LookalikeStore(dir, () => 1700000000000);
        store.visit("example.com");
        store.allow("paypa1.com");
        store.flush();
        expect(JSON.parse(fs.readFileSync(path.join(dir, "lookalike-allowed.json"), "utf8"))).toEqual(["paypa1.com"]);
        expect(JSON.parse(fs.readFileSync(path.join(dir, "lookalike-visits.json"), "utf8"))).toEqual({
            "example.com": { count: 1, last: 1700000000000 },
        });
        if (process.platform !== "win32") {
            expect(fs.statSync(path.join(dir, "lookalike-allowed.json")).mode & 0o077).toBe(0);
        }
    });

    it("starts empty from a missing, corrupt or hostile file", () => {
        fs.writeFileSync(path.join(dir, "lookalike-allowed.json"), "{not json");
        fs.writeFileSync(
            path.join(dir, "lookalike-visits.json"),
            JSON.stringify({
                "example.com": { count: "x" },
                "https://evil.example/path": { count: 5 },
                "good.org": { count: 4, last: 1 },
            })
        );
        const store = reopen();
        expect(store.isAllowed("example.com")).toBe(false);
        expect(store.frequent()).toEqual(["good.org"]);
        fs.writeFileSync(
            path.join(dir, "lookalike-allowed.json"),
            JSON.stringify(["ok.com", 5, null, "https://x.org/y", { a: 1 }])
        );
        const next = reopen();
        expect(next.isAllowed("ok.com")).toBe(true);
        expect(next.isAllowed("x.org")).toBe(false);
    });

    it("writes nothing until something changes", () => {
        const store = new LookalikeStore(dir);
        store.flush();
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});
