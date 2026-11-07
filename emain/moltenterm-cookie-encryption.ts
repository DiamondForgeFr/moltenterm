// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Rewrites, once per persistent session, the cookies an earlier version stored in clear, so a packaged build (cookie
// encryption fuse on, build/moltenterm/electron-fuses.cjs) holds no cookie value in clear on disk and keeps every
// sign-in (#2058, FR-BRW-014). The logic is in moltenterm-cookie-migration.ts.
//
// The development build keeps Electron's default fuses and stores its cookies in clear: nothing runs there.

import { fireAndForget } from "@/util/util";
import { app, safeStorage, session, type Session } from "electron";
import {
    type CookiePlan,
    cookiesToRewrite,
    markMigrated,
    planCookieMigration,
    setDetailsOf,
    storageKey,
} from "./moltenterm-cookie-migration";

const plans = new Map<string, CookiePlan>();

// Before the app is ready, while no session has opened its cookie database.
export async function planMoltentermCookieEncryption(): Promise<void> {
    if (!app.isPackaged) {
        return;
    }
    try {
        for (const [key, plan] of await planCookieMigration(app.getPath("userData"))) {
            plans.set(key, plan);
        }
    } catch (e) {
        console.log("cookie-encryption: could not read the cookie databases, trying again at the next start", e);
    }
}

// Once the app is ready, before any window: the default session now, each persistent partition when it is created.
export async function startMoltentermCookieEncryption(): Promise<void> {
    if (plans.size === 0) {
        return;
    }
    app.on("session-created", (ses) => fireAndForget(() => migrateSession(ses)));
    await migrateSession(session.defaultSession);
}

// The cookie store uses the same key as safeStorage. A key the system refuses (a denied keychain request) would make
// Chromium drop the rewritten rows instead of storing them, so nothing is rewritten then.
function encryptionWorks(): boolean {
    try {
        return (
            safeStorage.isEncryptionAvailable() && safeStorage.decryptString(safeStorage.encryptString("ok")) === "ok"
        );
    } catch {
        return false;
    }
}

async function migrateSession(ses: Session): Promise<void> {
    const storagePath = ses.storagePath;
    if (!storagePath) {
        return;
    }
    const key = storageKey(storagePath);
    const plan = plans.get(key);
    if (plan == null) {
        return;
    }
    plans.delete(key);
    try {
        if (plan.clear.length === 0) {
            markMigrated(storagePath, { rewritten: 0, failed: 0, partitionedleftclear: plan.partitioned.length });
            return;
        }
        if (!encryptionWorks()) {
            console.log(
                "cookie-encryption: the system key is not available, the clear cookies stay as they are until the next start"
            );
            return;
        }
        const targets = cookiesToRewrite(await ses.cookies.get({}), plan);
        let failed = 0;
        for (const cookie of targets) {
            try {
                await ses.cookies.set(setDetailsOf(cookie));
            } catch {
                failed++;
            }
        }
        await ses.cookies.flushStore();
        const summary = {
            rewritten: targets.length - failed,
            failed,
            partitionedleftclear: plan.partitioned.length,
        };
        markMigrated(storagePath, summary);
        console.log(
            `cookie-encryption: ${summary.rewritten} clear cookies stored encrypted (${failed} could not be set, ${summary.partitionedleftclear} partitioned left as they are)`
        );
    } catch (e) {
        console.log("cookie-encryption: migration failed, trying again at the next start", e);
    }
}
