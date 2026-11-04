// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The in-app update of a release (#1860, FR-REL-005, Notulia's flow), as Electron main runs it: on the user's acceptance
// of the release the check offered, download its file, verify it, stage it and install it through the gold swap (#64).
// The rules and the steps are in release-install.ts (shared) and moltenterm-release-install-core.ts (the installer);
// this file gives them the app: the network session, the release key bundled at build time, the platform's staging, the
// quit that runs the swap and the state pushed to every window. Only release installs (the builds of the release
// workflow) have it; a gold keeps the gold update.

import * as electron from "electron";
import fs from "fs";
import path from "path";
import { releaseFeedEnabled } from "../frontend/moltenterm-shell/update/release-feed";
import {
    installError,
    InstallFacts,
    installPlanOf,
    MoltentermReleaseInstallApplyChannel,
    MoltentermReleaseInstallEventChannel,
    MoltentermReleaseInstallLastChannel,
    MoltentermReleaseInstallRevealChannel,
    MoltentermReleaseInstallStartChannel,
    MoltentermReleaseInstallStateChannel,
    parseReleaseSwapStatus,
    ReleaseApplyWhen,
    ReleaseInstallPlan,
    ReleaseInstallResult,
    ReleaseInstallState,
    ReleaseSwapStatus,
} from "../frontend/moltenterm-shell/update/release-install";
import { appBundleOf } from "../frontend/util/moltenterm-gold";
import ReleaseKeyArmor from "../release-signing-key.asc?raw";
import { setUserConfirmedQuit } from "./emain-activity";
import { getWaveDataDir } from "./emain-platform";
import { getWaveTabViewByWebContentsId } from "./emain-tabview";
import { isAppImageHeader, releaseAppImageSwap } from "./moltenterm-appimage-swap";
import { readReleaseKey, ReleaseKey } from "./moltenterm-openpgp";
import { handleAppIpc } from "./moltenterm-privileged-ipc";
import { currentReleaseOffer, onReleaseCheck } from "./moltenterm-release-feed";
import { InstallDeps, ReleaseInstaller, StageFn } from "./moltenterm-release-install-core";
import { checkReleaseBundle, ownSigning, unpackReleaseZip } from "./moltenterm-release-mac";
import { releaseMacSwap, startSwap, swapOnQuit } from "./moltenterm-update";

declare const __MOLTENTERM_CHANNEL__: string;

// An in-memory session of its own, like the release feed's: no cookie of the browser panel's sign-ins rides along.
const InstallPartition = "moltenterm-release-install";

let installer: ReleaseInstaller = null;

function updateRoot(): string {
    return path.join(getWaveDataDir(), "molten", "update");
}

function releaseRoot(): string {
    return path.join(updateRoot(), "release");
}

function writable(target: string): boolean {
    try {
        fs.accessSync(target, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

// Where this install could replace itself, read when asked: the place can change under a running app (a volume mounted
// read-only, a folder moved).
export function currentFacts(): InstallFacts {
    const facts: InstallFacts = {
        platform: process.platform,
        arch: process.arch,
        packaged: electron.app.isPackaged,
    };
    if (process.platform === "darwin") {
        const bundle = appBundleOf(process.execPath);
        facts.bundle = bundle ?? undefined;
        facts.writable = bundle != null && writable(bundle) && writable(path.dirname(bundle));
    } else if (process.platform === "linux") {
        const image = process.env.APPIMAGE;
        facts.appImage = image && path.isAbsolute(image) && fs.existsSync(image) ? image : undefined;
        facts.writable = facts.appImage != null && writable(facts.appImage) && writable(path.dirname(facts.appImage));
        facts.dpkg = fs.existsSync("/usr/bin/dpkg");
    }
    return facts;
}

export function currentPlan(): ReleaseInstallPlan {
    return installPlanOf(currentFacts());
}

async function stageMac(staged: Parameters<StageFn>[0]) {
    const installed = appBundleOf(process.execPath);
    if (installed == null) {
        return { ok: false as const, error: installError("unsupported") };
    }
    const unpacked = await unpackReleaseZip(staged.file, path.join(staged.dir, "unpacked"));
    if ("error" in unpacked) {
        return { ok: false as const, error: unpacked.error };
    }
    await fs.promises.rm(staged.file, { force: true });
    let own: Awaited<ReturnType<typeof ownSigning>>;
    try {
        own = await ownSigning(installed);
    } catch (e) {
        return { ok: false as const, error: installError("codesign", e?.message ?? String(e)) };
    }
    const checked = await checkReleaseBundle(unpacked.app, staged.version, own);
    if (checked.ok === false) {
        return { ok: false as const, error: checked.error };
    }
    return {
        ok: true as const,
        swap: releaseMacSwap({
            staged: unpacked.app,
            installed,
            version: staged.version,
            requirement: checked.requirement,
            assess: checked.assess,
        }),
    };
}

async function stageLinux(staged: Parameters<StageFn>[0]) {
    const installed = currentFacts().appImage;
    if (installed == null) {
        return { ok: false as const, error: installError("unsupported") };
    }
    const handle = await fs.promises.open(staged.file, "r");
    const head = Buffer.alloc(16);
    try {
        await handle.read(head, 0, head.length, 0);
    } finally {
        await handle.close();
    }
    if (!isAppImageHeader(head)) {
        return { ok: false as const, error: installError("notapp", "the file is not an AppImage") };
    }
    return {
        ok: true as const,
        swap: releaseAppImageSwap({ staged: staged.file, installed, version: staged.version, sha256: staged.sha256 }),
    };
}

const stage: StageFn = async (staged) => {
    try {
        if (process.platform === "darwin") {
            return await stageMac(staged);
        }
        if (process.platform === "linux") {
            return await stageLinux(staged);
        }
        return { ok: false, error: installError("unsupported") };
    } catch (e) {
        console.log("[release-install] staging failed:", e?.message ?? e);
        return { ok: false, error: installError("disk", e?.message ?? String(e)) };
    }
};

// The state goes to every window's tab views, the way the accessibility snapshot does: they all show the same update.
function publish(state: ReleaseInstallState) {
    for (const contents of electron.webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && getWaveTabViewByWebContentsId(contents.id)) {
            contents.send(MoltentermReleaseInstallEventChannel, state);
        }
    }
}

function releaseKey(): ReleaseKey {
    return readReleaseKey(ReleaseKeyArmor);
}

function makeInstaller(): ReleaseInstaller {
    const deps: InstallDeps = {
        fetch: (url, init) => electron.session.fromPartition(InstallPartition).fetch(url, init),
        key: releaseKey(),
        env: process.env,
        platform: process.platform,
        arch: process.arch,
        plan: currentPlan(),
        workDir: (version) => path.join(releaseRoot(), version),
        downloadsDir: () => electron.app.getPath("downloads"),
        stage,
        arm: (swap) => swapOnQuit(swap),
        disarm: () => swapOnQuit(null),
        swapNow: (swap) => {
            startSwap(swap, true);
            setUserConfirmedQuit(true);
            setTimeout(() => electron.app.quit(), 300);
        },
        reveal: (file) => electron.shell.showItemInFolder(file),
        publish,
        nowMs: () => Date.now(),
    };
    return new ReleaseInstaller(deps);
}

// A fresh installer for the facts of the moment, unless an update is under way or staged: those keep theirs.
function installerNow(): ReleaseInstaller {
    if (installer == null || installer.getState().phase === "idle" || installer.getState().phase === "error") {
        installer = makeInstaller();
    }
    return installer;
}

function enabled(): boolean {
    return releaseFeedEnabled(__MOLTENTERM_CHANNEL__, electron.app.isPackaged, process.env);
}

async function startInstall(tag: unknown): Promise<ReleaseInstallResult> {
    if (!enabled() || typeof tag !== "string") {
        return { ok: false, error: installError("unsupported") };
    }
    // The renderer names the release; main accepts only the one its own last check offers now.
    const offer = await currentReleaseOffer();
    if (offer == null || offer.tag !== tag) {
        return { ok: false, error: installError("stale") };
    }
    try {
        return installerNow().start({ tag: offer.tag, version: offer.version });
    } catch (e) {
        console.log("[release-install] could not start:", e?.message ?? e);
        return { ok: false, error: installError("unsupported", e?.message ?? String(e)) };
    }
}

function statusFile(): string {
    return path.join(updateRoot(), "swap.status");
}

// The outcome of the last swap, read once at the next launch.
export function takeLastReleaseSwap(): ReleaseSwapStatus {
    try {
        const text = fs.readFileSync(statusFile(), "utf8");
        fs.rmSync(statusFile(), { force: true });
        return parseReleaseSwapStatus(text);
    } catch {
        return null;
    }
}

export function initMoltentermReleaseInstall() {
    if (!enabled()) {
        return;
    }
    // What an earlier run staged and never installed is gone with it: the next check offers the release again.
    fs.promises.rm(releaseRoot(), { recursive: true, force: true }).catch(() => {});
    handleAppIpc(MoltentermReleaseInstallStateChannel, () => ({
        state: installer?.getState() ?? { phase: "idle" },
        plan: currentPlan(),
    }));
    handleAppIpc(MoltentermReleaseInstallStartChannel, (_event, tag: unknown) => startInstall(tag));
    handleAppIpc(MoltentermReleaseInstallApplyChannel, (_event, when: ReleaseApplyWhen) =>
        installer == null || (when !== "now" && when !== "quit")
            ? { ok: false, error: installError("stale") }
            : installer.apply(when)
    );
    handleAppIpc(MoltentermReleaseInstallRevealChannel, () =>
        installer == null ? { ok: false, error: installError("stale") } : installer.reveal()
    );
    handleAppIpc(MoltentermReleaseInstallLastChannel, () => takeLastReleaseSwap());
    // A release that is no longer the one offered (a newer one, the preference turned off) takes its staged update with it.
    onReleaseCheck((check) => {
        const state = installer?.getState();
        if (state == null || state.tag == null) {
            return;
        }
        if (check.offer?.tag !== state.tag) {
            installer.forget();
        }
    });
    // A download in flight ends with the app.
    electron.app.on("before-quit", () => installer?.cancel());
}
