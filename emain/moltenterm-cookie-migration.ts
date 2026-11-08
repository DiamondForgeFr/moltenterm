// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one-time move of a profile's clear cookies to encrypted storage (#2058, FR-BRW-014). With the cookie encryption
// fuse on, Chromium still reads a row an earlier version wrote in clear (`value` set, `encrypted_value` empty), so no
// sign-in is lost, but it keeps that row in clear until the site sets the cookie again. Setting the same cookie again
// through the session makes Chromium write it encrypted and drop the clear row.
//
// The database is read before the app is ready: once Chromium opens it, it holds an exclusive lock. Electron's cookie
// API has no partition key, so a partitioned cookie (CHIPS, a site embedded in another) would come back unpartitioned:
// those rows are left as they are, and Chromium encrypts them when their site sets them again.
//
// No Electron import here, so the logic runs under vitest; emain/moltenterm-cookie-encryption.ts wires it to the app.

import fs from "node:fs";
import path from "node:path";

export const CookieDatabaseName = "Cookies";
export const CookieMarkerName = "moltenterm-cookies-encrypted.json";
export const CookieMarkerVersion = 1;

export type CookieRowKey = { host: string; name: string; path: string };
export type ClearCookieRow = CookieRowKey & { value: string };

// What a session's database held in clear when the app started. `partitioned` rows are never rewritten.
export type CookiePlan = { storagePath: string; clear: ClearCookieRow[]; partitioned: CookieRowKey[] };

// The fields of Electron's Cookie this module reads.
export type CookieLike = {
    name: string;
    value: string;
    domain?: string;
    hostOnly?: boolean;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    session?: boolean;
    expirationDate?: number;
    sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
};

export type CookieSetDetails = {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
    sameSite: CookieLike["sameSite"];
};

// node:sqlite's DatabaseSync, the part used here.
type SqliteDatabase = {
    prepare(sql: string): { all(): unknown[] };
    close(): void;
};
export type OpenReadOnly = (file: string) => SqliteDatabase | Promise<SqliteDatabase>;

export async function openWithNodeSqlite(file: string): Promise<SqliteDatabase> {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file, { readOnly: true }) as unknown as SqliteDatabase;
}

function realPath(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

export function storageKey(storagePath: string): string {
    return realPath(storagePath);
}

export function isMigrated(storagePath: string): boolean {
    return fs.existsSync(path.join(storagePath, CookieMarkerName));
}

export function markMigrated(storagePath: string, summary: Record<string, number>): void {
    fs.writeFileSync(
        path.join(storagePath, CookieMarkerName),
        JSON.stringify({ version: CookieMarkerVersion, at: new Date().toISOString(), ...summary }) + "\n",
        { mode: 0o600 }
    );
}

// The default session keeps its data in userData itself, each persistent partition in userData/Partitions/<name>.
export function persistentStoragePaths(userData: string): string[] {
    const paths = [userData];
    const partitions = path.join(userData, "Partitions");
    let names: string[] = [];
    try {
        names = fs.readdirSync(partitions);
    } catch {
        return paths;
    }
    for (const name of names) {
        const dir = path.join(partitions, name);
        try {
            if (fs.statSync(dir).isDirectory()) {
                paths.push(dir);
            }
        } catch {
            // gone meanwhile
        }
    }
    return paths;
}

// The rows of a cookie database whose value is in clear, or null when the database cannot be read now (locked by
// another process, a journal left by a crash): the next start tries again. No database means nothing in clear.
export async function readClearCookies(
    dbPath: string,
    open: OpenReadOnly = openWithNodeSqlite
): Promise<{ clear: ClearCookieRow[]; partitioned: CookieRowKey[] } | null> {
    if (!fs.existsSync(dbPath)) {
        return { clear: [], partitioned: [] };
    }
    let db: SqliteDatabase;
    try {
        db = await open(dbPath);
    } catch {
        return null;
    }
    try {
        const columns = new Set(
            (db.prepare("PRAGMA table_info(cookies)").all() as { name: string }[]).map((c) => c.name)
        );
        if (!columns.has("value") || !columns.has("host_key")) {
            return null;
        }
        const partition = columns.has("top_frame_site_key") ? "top_frame_site_key" : "''";
        const rows = db
            .prepare(`SELECT host_key, name, path, value, ${partition} AS partition_key FROM cookies WHERE value != ''`)
            .all() as { host_key: string; name: string; path: string; value: string; partition_key: string }[];
        const clear: ClearCookieRow[] = [];
        const partitioned: CookieRowKey[] = [];
        for (const r of rows) {
            const key = { host: r.host_key, name: r.name, path: r.path };
            if (r.partition_key) {
                partitioned.push(key);
            } else {
                clear.push({ ...key, value: r.value });
            }
        }
        return { clear, partitioned };
    } catch {
        return null;
    } finally {
        db.close();
    }
}

// The plan of every persistent session not migrated yet, by storage path (real path).
export async function planCookieMigration(
    userData: string,
    open: OpenReadOnly = openWithNodeSqlite
): Promise<Map<string, CookiePlan>> {
    const plans = new Map<string, CookiePlan>();
    for (const storagePath of persistentStoragePaths(userData)) {
        if (isMigrated(storagePath)) {
            continue;
        }
        const found = await readClearCookies(path.join(storagePath, CookieDatabaseName), open);
        if (found == null) {
            continue;
        }
        plans.set(storageKey(storagePath), { storagePath, ...found });
    }
    return plans;
}

function keyOf(host: string, name: string, cookiePath: string): string {
    return `${host}\t${name}\t${cookiePath}`;
}

// The cookies of the session that are still the ones written in clear: same host, name, path and value. A cookie the
// site changed since, or that shares its key with a partitioned row, is left to Chromium.
export function cookiesToRewrite<T extends CookieLike>(cookies: T[], plan: CookiePlan): T[] {
    const clear = new Map(plan.clear.map((r) => [keyOf(r.host, r.name, r.path), r.value]));
    const partitioned = new Set(plan.partitioned.map((r) => keyOf(r.host, r.name, r.path)));
    return cookies.filter((c) => {
        const key = keyOf(c.domain ?? "", c.name, c.path ?? "");
        return !partitioned.has(key) && clear.get(key) === c.value;
    });
}

// The details that set the same cookie again: a host-only cookie stays host-only, a domain cookie keeps its domain, a
// session cookie stays a session cookie.
export function setDetailsOf(cookie: CookieLike): CookieSetDetails {
    const domain = cookie.domain ?? "";
    const host = domain.replace(/^\./, "");
    const cookiePath = cookie.path || "/";
    const details: CookieSetDetails = {
        url: `${cookie.secure ? "https" : "http"}://${host}${cookiePath}`,
        name: cookie.name,
        value: cookie.value,
        path: cookiePath,
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        sameSite: cookie.sameSite,
    };
    if (!cookie.hostOnly) {
        details.domain = domain;
    }
    if (!cookie.session && cookie.expirationDate != null) {
        details.expirationDate = cookie.expirationDate;
    }
    return details;
}
