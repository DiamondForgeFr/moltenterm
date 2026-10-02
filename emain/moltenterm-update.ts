// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold update (#64), modelled on Notulia's local update (src-tauri/src/local_update.rs): the installed gold reads
// the manifest the gold delivery writes, stages a copy of the new app, quits, and a detached script swaps the app
// bundle, reopens it and rolls back when the new build does not stay open. Configuration and data live outside the
// bundle, so nothing of the user's is touched.

import { execFile, spawn } from "child_process";
import * as electron from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
    appBundleOf,
    checkGoldManifest,
    GoldApplyResult,
    GoldApplyWhen,
    GoldAppName,
    GoldCheck,
    GoldIdentifier,
    GoldMaxManifestBytes,
    GoldSwapStatus,
    MoltentermUpdateApplyChannel,
    MoltentermUpdateCheckChannel,
    MoltentermUpdateLastChannel,
    parseSwapStatus,
} from "../frontend/util/moltenterm-gold";
import { setUserConfirmedQuit } from "./emain-activity";
import { getWaveDataDir } from "./emain-platform";

const execFileAsync = promisify(execFile);

// Seconds the swap waits for the new build to stay open before keeping it.
const SwapGraceSeconds = 15;

function goldDir(): string {
    if (process.env.MOLTENTERM_GOLD_DIR) {
        return process.env.MOLTENTERM_GOLD_DIR;
    }
    return path.join(os.homedir(), "Library", "Application Support", "Moltenterm Local Builds", "gold");
}

function updateDir(): string {
    return path.join(getWaveDataDir(), "molten", "update");
}

function statusFile(): string {
    return path.join(updateDir(), "swap.status");
}

async function readManifest(): Promise<any> {
    const file = path.join(goldDir(), "manifest.json");
    const stat = await fs.promises.stat(file);
    if (stat.size > GoldMaxManifestBytes) {
        throw new Error("manifest too large");
    }
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
}

async function plistValue(app: string, key: string): Promise<string> {
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
        "-c",
        `Print :${key}`,
        path.join(app, "Contents", "Info.plist"),
    ]);
    return stdout.trim();
}

// The bundle must be the build the manifest announces: same identifier, and its bundle version is the build id.
async function verifyBundle(app: string, buildId: number): Promise<string> {
    try {
        if ((await plistValue(app, "CFBundleIdentifier")) !== GoldIdentifier) {
            return "the app is not Moltenterm";
        }
        if ((await plistValue(app, "CFBundleVersion")) !== String(buildId)) {
            return "the app's build does not match its manifest";
        }
    } catch (e) {
        return `the app cannot be read (${e?.message ?? e})`;
    }
    return null;
}

export async function checkGoldUpdate(ownBuildId: number): Promise<GoldCheck> {
    if (process.platform !== "darwin" || !electron.app.isPackaged) {
        return { available: false };
    }
    let manifest: any;
    try {
        manifest = await readManifest();
    } catch (e) {
        if (e?.code === "ENOENT") {
            return { available: false };
        }
        return { available: false, reason: `unreadable manifest (${e?.message ?? e})` };
    }
    const check = checkGoldManifest(manifest, ownBuildId);
    if (!check.available) {
        return check;
    }
    const problem = await verifyBundle(path.join(goldDir(), GoldAppName), check.manifest.buildId);
    if (problem) {
        console.log("[gold-update] refused:", problem);
        return { available: false, manifest: check.manifest, reason: problem };
    }
    return check;
}

const SwapScript = `#!/bin/sh
# Swaps the Moltenterm app bundle once the running app has quit (#64). Arguments: pid staged target reopen buildId
# status.
pid="$1"; staged="$2"; target="$3"; reopen="$4"; build="$5"; status="$6"
grace="\${MOLTENTERM_SWAP_GRACE:-${SwapGraceSeconds}}"
# Tests start the binary directly so the reopened app keeps their isolated profile; users get a normal launch.
reopen_app() {
    if [ -n "$MOLTENTERM_SWAP_DIRECT" ]; then
        "$1/Contents/MacOS/Moltenterm" >/dev/null 2>&1 &
    else
        open "$1"
    fi
}
i=0
while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 240 ]; then echo "failed: Moltenterm did not quit" > "$status"; exit 1; fi
    sleep 0.5
done
aside="$target.previous-$$"
if ! mv "$target" "$aside"; then echo "failed: the installed app could not be moved aside" > "$status"; exit 1; fi
if ! mv "$staged" "$target"; then
    mv "$aside" "$target"
    echo "failed: the new build could not be put in place" > "$status"
    [ "$reopen" = 1 ] && reopen_app "$target"
    exit 1
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null
if [ "$reopen" != 1 ]; then
    rm -rf "$aside"
    echo "installed $build" > "$status"
    exit 0
fi
reopen_app "$target"
sleep "$grace"
if pgrep -f "$target/Contents/MacOS/" >/dev/null; then
    rm -rf "$aside"
    echo "installed $build" > "$status"
    exit 0
fi
mv "$target" "$target.did-not-stay-open-$$" && mv "$aside" "$target"
rm -rf "$target.did-not-stay-open-$$"
echo "rolledback $build" > "$status"
reopen_app "$target"
`;

type PendingSwap = { staged: string; target: string; buildId: number };

let pendingOnQuit: PendingSwap = null;

function startSwap(swap: PendingSwap, reopen: boolean) {
    const dir = updateDir();
    const script = path.join(dir, "swap.sh");
    fs.writeFileSync(script, SwapScript, { mode: 0o755 });
    fs.rmSync(statusFile(), { force: true });
    const log = fs.openSync(path.join(dir, "swap.log"), "a");
    const child = spawn(
        "/bin/sh",
        [script, String(process.pid), swap.staged, swap.target, reopen ? "1" : "0", String(swap.buildId), statusFile()],
        { detached: true, stdio: ["ignore", log, log] }
    );
    child.unref();
    console.log("[gold-update] swap started", swap.buildId, reopen ? "(reopen)" : "(on quit)");
}

async function stage(buildId: number): Promise<PendingSwap> {
    const target = appBundleOf(process.execPath);
    if (target == null) {
        throw new Error("Moltenterm does not run from an app bundle");
    }
    if (target.includes("/AppTranslocation/")) {
        throw new Error("Moltenterm runs from a translocated copy: move it to Applications first");
    }
    const source = path.join(goldDir(), GoldAppName);
    const problem = await verifyBundle(source, buildId);
    if (problem) {
        throw new Error(problem);
    }
    const dir = path.join(updateDir(), String(buildId));
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
    const staged = path.join(dir, GoldAppName);
    await execFileAsync("/usr/bin/ditto", [source, staged]);
    const stagedProblem = await verifyBundle(staged, buildId);
    if (stagedProblem) {
        throw new Error(stagedProblem);
    }
    return { staged, target, buildId };
}

export async function applyGoldUpdate(buildId: number, when: GoldApplyWhen): Promise<GoldApplyResult> {
    try {
        const check = await checkGoldUpdate(0);
        if (check.manifest?.buildId !== buildId) {
            return { ok: false, error: "the gold changed meanwhile: check again" };
        }
        const swap = await stage(buildId);
        if (when === "quit") {
            pendingOnQuit = swap;
            return { ok: true };
        }
        startSwap(swap, true);
        setUserConfirmedQuit(true);
        setTimeout(() => electron.app.quit(), 300);
        return { ok: true };
    } catch (e) {
        console.log("[gold-update] apply failed:", e?.message ?? e);
        return { ok: false, error: e?.message ?? String(e) };
    }
}

export function takeLastSwapStatus(): GoldSwapStatus {
    try {
        const text = fs.readFileSync(statusFile(), "utf8");
        fs.rmSync(statusFile(), { force: true });
        return parseSwapStatus(text);
    } catch {
        return null;
    }
}

export function initMoltentermUpdate() {
    electron.ipcMain.handle(MoltentermUpdateCheckChannel, (_event, ownBuildId: number) => checkGoldUpdate(ownBuildId));
    electron.ipcMain.handle(MoltentermUpdateApplyChannel, (_event, buildId: number, when: GoldApplyWhen) =>
        applyGoldUpdate(buildId, when)
    );
    electron.ipcMain.handle(MoltentermUpdateLastChannel, () => takeLastSwapStatus());
    // "Update when I quit": the swap starts as the app ends, without reopening it.
    electron.app.on("will-quit", () => {
        if (pendingOnQuit == null) {
            return;
        }
        const swap = pendingOnQuit;
        pendingOnQuit = null;
        startSwap(swap, false);
    });
}
