// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
    CookieDatabaseName,
    type CookieLike,
    CookieMarkerName,
    cookiesToRewrite,
    isMigrated,
    markMigrated,
    persistentStoragePaths,
    planCookieMigration,
    readClearCookies,
    setDetailsOf,
    storageKey,
} from "./moltenterm-cookie-migration";

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-cookies-"));
    dirs.push(dir);
    return dir;
}

type Row = { host: string; name: string; path?: string; value?: string; encrypted?: Buffer; partition?: string };

// The columns of Chromium's cookies table this module reads, with the encrypted value beside them.
function cookieDatabase(dir: string, rows: Row[]): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, CookieDatabaseName);
    const db = new DatabaseSync(file);
    db.exec(
        "CREATE TABLE cookies (host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL)"
    );
    const insert = db.prepare(
        "INSERT INTO cookies (host_key, top_frame_site_key, name, value, encrypted_value, path) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const r of rows) {
        insert.run(r.host, r.partition ?? "", r.name, r.value ?? "", r.encrypted ?? Buffer.alloc(0), r.path ?? "/");
    }
    db.close();
    return file;
}

const Encrypted = Buffer.from("v10 not a clear value");

describe("reading what a profile holds in clear (#2058)", () => {
    it("finds the clear rows, keeps partitioned ones apart and skips encrypted ones", async () => {
        const file = cookieDatabase(tempDir(), [
            { host: "example.com", name: "sid", value: "s3cret" },
            { host: ".example.com", name: "pref", value: "dark", path: "/app" },
            { host: "widget.test", name: "chip", value: "p1", partition: "https://example.com" },
            { host: "example.com", name: "new", encrypted: Encrypted },
        ]);
        expect(await readClearCookies(file)).toEqual({
            clear: [
                { host: "example.com", name: "sid", path: "/", value: "s3cret" },
                { host: ".example.com", name: "pref", path: "/app", value: "dark" },
            ],
            partitioned: [{ host: "widget.test", name: "chip", path: "/" }],
        });
    });

    it("finds nothing in clear when there is no database yet", async () => {
        expect(await readClearCookies(path.join(tempDir(), CookieDatabaseName))).toEqual({
            clear: [],
            partitioned: [],
        });
    });

    it("gives no answer for a database it cannot read, so the next start tries again", async () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, CookieDatabaseName), "not a database");
        expect(await readClearCookies(path.join(dir, CookieDatabaseName))).toBeNull();
        const locked = cookieDatabase(tempDir(), [{ host: "a.test", name: "x", value: "1" }]);
        const refusing = () => {
            throw new Error("database is locked");
        };
        expect(await readClearCookies(locked, refusing)).toBeNull();
    });
});

describe("the plan of a profile", () => {
    it("covers the default session and each persistent partition not migrated yet", async () => {
        const userData = tempDir();
        cookieDatabase(userData, [{ host: "a.test", name: "sid", value: "1" }]);
        const work = path.join(userData, "Partitions", "work");
        cookieDatabase(work, [{ host: "b.test", name: "sid", value: "2" }]);
        const done = path.join(userData, "Partitions", "done");
        cookieDatabase(done, [{ host: "c.test", name: "sid", value: "3" }]);
        markMigrated(done, { rewritten: 1 });
        fs.mkdirSync(path.join(userData, "Partitions", "fresh"));

        expect(persistentStoragePaths(userData)).toHaveLength(4);
        const plans = await planCookieMigration(userData);
        expect([...plans.keys()].sort()).toEqual(
            [storageKey(userData), storageKey(work), storageKey(path.join(userData, "Partitions", "fresh"))].sort()
        );
        expect(plans.get(storageKey(userData)).clear).toEqual([{ host: "a.test", name: "sid", path: "/", value: "1" }]);
        expect(plans.get(storageKey(path.join(userData, "Partitions", "fresh"))).clear).toEqual([]);
    });

    it("is empty once every session is marked", async () => {
        const userData = tempDir();
        cookieDatabase(userData, [{ host: "a.test", name: "sid", value: "1" }]);
        expect(isMigrated(userData)).toBe(false);
        markMigrated(userData, { rewritten: 1, failed: 0 });
        expect(isMigrated(userData)).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(userData, CookieMarkerName), "utf8"))).toMatchObject({
            version: 1,
            rewritten: 1,
        });
        expect((await planCookieMigration(userData)).size).toBe(0);
    });
});

function cookie(over: Partial<CookieLike> = {}): CookieLike {
    return {
        name: "sid",
        value: "s3cret",
        domain: "example.com",
        hostOnly: true,
        path: "/",
        secure: false,
        httpOnly: true,
        session: false,
        expirationDate: 1893456000,
        sameSite: "lax",
        ...over,
    };
}

describe("the cookies set again", () => {
    const plan = {
        storagePath: "/x",
        clear: [
            { host: "example.com", name: "sid", path: "/", value: "s3cret" },
            { host: ".example.com", name: "pref", path: "/app", value: "dark" },
            { host: "widget.test", name: "chip", path: "/", value: "p1" },
        ],
        partitioned: [{ host: "widget.test", name: "chip", path: "/" }],
    };

    it("are the ones still holding the value written in clear", () => {
        const kept = cookie();
        const domainWide = cookie({
            name: "pref",
            value: "dark",
            domain: ".example.com",
            hostOnly: false,
            path: "/app",
        });
        const changed = cookie({ value: "rotated" });
        const otherHost = cookie({ domain: "other.test" });
        const encryptedAlready = cookie({ name: "new", value: "fresh" });
        const chip = cookie({ name: "chip", value: "p1", domain: "widget.test" });
        expect(cookiesToRewrite([kept, domainWide, changed, otherHost, encryptedAlready, chip], plan)).toEqual([
            kept,
            domainWide,
        ]);
    });

    it("keep host-only, domain, path, flags, SameSite and expiry", () => {
        expect(setDetailsOf(cookie())).toEqual({
            url: "http://example.com/",
            name: "sid",
            value: "s3cret",
            path: "/",
            secure: false,
            httpOnly: true,
            sameSite: "lax",
            expirationDate: 1893456000,
        });
        expect(
            setDetailsOf(
                cookie({
                    domain: ".example.com",
                    hostOnly: false,
                    secure: true,
                    path: "/app",
                    sameSite: "no_restriction",
                })
            )
        ).toMatchObject({
            url: "https://example.com/app",
            domain: ".example.com",
            secure: true,
            sameSite: "no_restriction",
        });
    });

    it("keep a session cookie a session cookie", () => {
        const details = setDetailsOf(cookie({ session: true, expirationDate: undefined }));
        expect(details).not.toHaveProperty("expirationDate");
        expect(details).not.toHaveProperty("domain");
    });
});
