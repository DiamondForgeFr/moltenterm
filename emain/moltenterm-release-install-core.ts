// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The installer of the in-app update of a release (#1860, FR-REL-005), without Electron: the glue
// (moltenterm-release-install.ts) hands it what it needs from the app (the network session, the platform's staging step,
// the swap), and the tests hand it a local server and fake files. On the user's acceptance it downloads the signed
// checksum list and its signature, verifies the signature with the release key, downloads the file for this computer
// while hashing it, compares the hash with the signed list, and stages it. Nothing is skipped and the order does not
// change: a failure at any step stops there, removes what was downloaded and says why. The state is reported at every
// change, the way Notulia's update store does, so any window can follow it.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import {
    ChecksumsName,
    ChecksumsSignatureName,
    IdleInstallState,
    installError,
    MaxArtifactBytes,
    MaxChecksumsBytes,
    MaxSignatureBytes,
    parseChecksums,
    releaseFileName,
    releaseFileUrl,
    ReleaseInstallError,
    ReleaseInstallPlan,
    ReleaseInstallResult,
    ReleaseInstallState,
} from "../frontend/moltenterm-shell/update/release-install";
import { ReleaseKey, SignatureFailure, verifyDetachedSignature } from "./moltenterm-openpgp";
import type { PendingSwap } from "./moltenterm-update";

// A download that gets no byte for this long is given up.
const DefaultStallMs = 60_000;
const SmallFileTimeoutMs = 30_000;

export type FetchLike = (url: string, init: { signal: AbortSignal; credentials?: "omit" }) => Promise<Response>;

// What the platform does with the verified file (macOS: unpack and judge the app; Linux: check the AppImage's place).
export type StageResult = { ok: true; swap: PendingSwap } | { ok: false; error: ReleaseInstallError };
export type StageFn = (staged: {
    file: string;
    name: string;
    version: string;
    dir: string;
    sha256: string;
}) => Promise<StageResult>;

export type InstallDeps = {
    fetch: FetchLike;
    key: ReleaseKey;
    env: Record<string, string | undefined>;
    platform: string;
    arch: string;
    plan: ReleaseInstallPlan;
    // Where one version is staged: the folder is made and emptied by the installer.
    workDir: (version: string) => string;
    downloadsDir: () => string;
    stage: StageFn;
    // The staged update installs when MoltenTerm quits (the user accepted it).
    arm: (swap: PendingSwap) => void;
    disarm: () => void;
    // Restart now: runs the swap with a reopen and quits.
    swapNow: (swap: PendingSwap) => void;
    reveal: (file: string) => void;
    publish: (state: ReleaseInstallState) => void;
    nowMs: () => number;
    stallMs?: number;
};

export type OfferToInstall = { tag: string; version: string };

const SignatureFailures: Record<SignatureFailure, string> = {
    unreadable: "the signature cannot be read",
    unsupported: "the signature is of a kind the app does not accept",
    wrongkey: "the signature is not by the DiamondForge release key",
    badtime: "the signature was made outside the key's validity",
    expired: "the signature has expired",
    bad: "the signature does not match the checksum list",
};

class StepFailed extends Error {
    constructor(readonly error: ReleaseInstallError) {
        super(error.kind);
    }
}

// Once a download has been given up on purpose (a new install, a quit), whatever it reports is not a failure to show.
class Cancelled extends Error {}

export class ReleaseInstaller {
    private current: ReleaseInstallState = IdleInstallState;
    private swap: PendingSwap = null;
    private run: Promise<void> = null;
    private abort: AbortController = null;

    constructor(private deps: InstallDeps) {}

    getState(): ReleaseInstallState {
        return this.current;
    }

    // Resolves when the download, if any, has ended (for whoever must wait for it: the tests, a quit).
    whenDone(): Promise<void> {
        return this.run ?? Promise.resolve();
    }

    cancel() {
        this.abort?.abort(new Cancelled());
    }

    // The user's Cancel (#2163): the download stops, what it fetched is removed and the state goes back to idle, so the
    // offer stands. A staged update is not a download: Cancel does not withdraw it.
    cancelDownload(): ReleaseInstallResult {
        if (this.current.phase !== "downloading" && this.current.phase !== "verifying") {
            return { ok: false, error: installError("stale") };
        }
        this.cancel();
        return { ok: true };
    }

    private set(state: ReleaseInstallState) {
        this.current = state;
        this.deps.publish(state);
    }

    private fail(error: ReleaseInstallError, offer: OfferToInstall) {
        this.set({ phase: "error", tag: offer.tag, version: offer.version, mode: this.deps.plan.mode, error });
    }

    // The user accepted the offer. Starts the work and answers at once; the state tells how it goes.
    start(offer: OfferToInstall): ReleaseInstallResult {
        const plan = this.deps.plan;
        if (plan.mode === "none" || plan.kind == null) {
            return { ok: false, error: installError("unsupported") };
        }
        if (offer.tag !== `v${offer.version}`) {
            return { ok: false, error: installError("stale") };
        }
        const phase = this.current.phase;
        if (phase === "downloading" || phase === "verifying") {
            return this.current.tag === offer.tag ? { ok: true } : { ok: false, error: installError("busy") };
        }
        if (phase === "ready" && this.current.tag === offer.tag) {
            return { ok: true };
        }
        this.swap = null;
        this.deps.disarm();
        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.set({ phase: "downloading", tag: offer.tag, version: offer.version, mode: plan.mode, percent: 0 });
        this.run = this.download(offer, signal)
            .catch((e) => {
                if (e instanceof Cancelled || signal.reason instanceof Cancelled) {
                    this.set(IdleInstallState);
                    return;
                }
                this.fail(e instanceof StepFailed ? e.error : installError("disk", e?.message ?? String(e)), offer);
            })
            .finally(() => {
                this.run = null;
            });
        return { ok: true };
    }

    // Restart now, or leave the update armed for the quit. Only a staged swap has either.
    apply(when: "now" | "quit"): ReleaseInstallResult {
        if (this.current.phase !== "ready" || this.current.mode !== "swap" || this.swap == null) {
            return { ok: false, error: installError("stale") };
        }
        if (when === "now") {
            // The update is armed for the quit since it was staged: left armed, the quit this restart causes would
            // run a second swap of the same files beside this one (found by the real-app check, #1860).
            this.deps.disarm();
            this.deps.swapNow(this.swap);
        } else {
            this.deps.arm(this.swap);
        }
        return { ok: true };
    }

    reveal(): ReleaseInstallResult {
        if (this.current.phase !== "ready" || this.current.mode !== "download" || !this.current.file) {
            return { ok: false, error: installError("stale") };
        }
        this.deps.reveal(this.current.file);
        return { ok: true };
    }

    // An offer that is no longer the current one (a newer release, the preference turned off) withdraws a staged update.
    forget() {
        if (this.current.phase === "downloading" || this.current.phase === "verifying") {
            return;
        }
        this.swap = null;
        this.deps.disarm();
        this.set(IdleInstallState);
    }

    private async small(url: string, cap: number, signal: AbortSignal, absent: ReleaseInstallError): Promise<Buffer> {
        let response: Response;
        try {
            response = await this.deps.fetch(url, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(SmallFileTimeoutMs)]),
                credentials: "omit",
            });
        } catch (e) {
            throw this.networkError(e, signal);
        }
        if (response.status === 404) {
            throw new StepFailed(absent);
        }
        if (!response.ok) {
            throw new StepFailed(installError("network", `HTTP ${response.status}`));
        }
        if (Number(response.headers.get("content-length") ?? 0) > cap) {
            throw new StepFailed(installError("toolarge"));
        }
        try {
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > cap) {
                throw new StepFailed(installError("toolarge"));
            }
            return bytes;
        } catch (e) {
            if (e instanceof StepFailed) {
                throw e;
            }
            throw this.networkError(e, signal);
        }
    }

    private networkError(e: any, signal: AbortSignal): Error {
        if (signal.reason instanceof Cancelled) {
            return signal.reason;
        }
        return new StepFailed(installError("network", e?.cause?.code ?? e?.message ?? String(e)));
    }

    private async download(offer: OfferToInstall, signal: AbortSignal): Promise<void> {
        const { deps } = this;
        const plan = deps.plan;
        const name = releaseFileName(plan.kind, deps.platform, deps.arch, offer.version);
        const sumsUrl = releaseFileUrl(offer.tag, ChecksumsName, deps.env);
        const signatureUrl = releaseFileUrl(offer.tag, ChecksumsSignatureName, deps.env);
        const fileUrl = name == null ? null : releaseFileUrl(offer.tag, name, deps.env);
        if (name == null || sumsUrl == null || signatureUrl == null || fileUrl == null) {
            throw new StepFailed(installError("unsupported"));
        }
        const dir = deps.workDir(offer.version);
        await fs.promises.rm(dir, { recursive: true, force: true });
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        try {
            // 1. The signed list: the signature first, over exactly the bytes that were downloaded.
            const sums = await this.small(sumsUrl, MaxChecksumsBytes, signal, installError("missing", ChecksumsName));
            const signature = await this.small(
                signatureUrl,
                MaxSignatureBytes,
                signal,
                installError("unsigned", ChecksumsSignatureName)
            );
            const verdict = verifyDetachedSignature(deps.key, signature.toString("utf8"), sums, deps.nowMs() / 1000);
            if (verdict.ok === false) {
                throw new StepFailed(installError("signature", SignatureFailures[verdict.reason]));
            }
            const list = parseChecksums(sums.toString("utf8"));
            if (list == null) {
                throw new StepFailed(installError("checksum", "the checksum list is malformed"));
            }
            const expected = list.get(name);
            if (expected == null) {
                throw new StepFailed(installError("missing", name));
            }
            // 2. The file, hashed as it arrives.
            const file = path.join(dir, name);
            const sha256 = await this.downloadFile(fileUrl, file, offer, signal);
            this.set({ phase: "verifying", tag: offer.tag, version: offer.version, mode: plan.mode });
            // 3. Its hash must be the signed one.
            if (sha256 !== expected) {
                throw new StepFailed(installError("checksum", name));
            }
            if (signal.aborted) {
                throw new Cancelled();
            }
            if (plan.mode === "download") {
                const kept = await this.keepInDownloads(file, name);
                await fs.promises.rm(dir, { recursive: true, force: true });
                this.set({ phase: "ready", tag: offer.tag, version: offer.version, mode: "download", file: kept });
                return;
            }
            // 4. The platform's own judgement of what it holds, then the staged swap.
            const staged = await deps.stage({ file, name, version: offer.version, dir, sha256 });
            if (staged.ok === false) {
                throw new StepFailed(staged.error);
            }
            if (signal.aborted) {
                throw new Cancelled();
            }
            this.swap = staged.swap;
            // The user accepted the install, so it is armed: Later means "when MoltenTerm quits" (FR-REL-005).
            deps.arm(staged.swap);
            this.set({ phase: "ready", tag: offer.tag, version: offer.version, mode: "swap", armed: true });
        } catch (e) {
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
            throw e;
        }
    }

    private async downloadFile(url: string, file: string, offer: OfferToInstall, signal: AbortSignal): Promise<string> {
        const { deps } = this;
        const stallMs = deps.stallMs ?? DefaultStallMs;
        const stall = new AbortController();
        const watched = AbortSignal.any([signal, stall.signal]);
        let timer: NodeJS.Timeout = null;
        const feed = () => {
            clearTimeout(timer);
            timer = setTimeout(() => stall.abort(new Error("no data for a while")), stallMs);
        };
        feed();
        try {
            let response: Response;
            try {
                response = await deps.fetch(url, { signal: watched, credentials: "omit" });
            } catch (e) {
                throw this.networkError(stall.signal.aborted ? stall.signal.reason : e, signal);
            }
            if (response.status === 404) {
                throw new StepFailed(installError("missing", path.basename(file)));
            }
            if (!response.ok || response.body == null) {
                throw new StepFailed(installError("network", `HTTP ${response.status}`));
            }
            const length = Number(response.headers.get("content-length") ?? 0);
            if (length > MaxArtifactBytes) {
                throw new StepFailed(installError("toolarge"));
            }
            const hash = createHash("sha256");
            let received = 0;
            let shown = -1;
            const meter = new Transform({
                transform: (chunk: Buffer, _encoding, callback) => {
                    received += chunk.length;
                    if (received > MaxArtifactBytes) {
                        callback(new StepFailed(installError("toolarge")));
                        return;
                    }
                    hash.update(chunk);
                    feed();
                    if (length > 0) {
                        const percent = Math.min(99, Math.floor((received / length) * 100));
                        if (percent !== shown) {
                            shown = percent;
                            this.set({
                                phase: "downloading",
                                tag: offer.tag,
                                version: offer.version,
                                mode: deps.plan.mode,
                                percent,
                            });
                        }
                    }
                    callback(null, chunk);
                },
            });
            try {
                await pipeline(
                    Readable.fromWeb(response.body as any),
                    meter,
                    fs.createWriteStream(file, { mode: 0o600 }),
                    { signal: watched }
                );
            } catch (e) {
                if (e instanceof StepFailed) {
                    throw e;
                }
                throw this.networkError(stall.signal.aborted ? stall.signal.reason : e, signal);
            }
            return hash.digest("hex");
        } finally {
            clearTimeout(timer);
        }
    }

    // The file a person installs by hand goes to their Downloads folder, and stays there for them.
    private async keepInDownloads(file: string, name: string): Promise<string> {
        const target = path.join(this.deps.downloadsDir(), name);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(file, target);
        return target;
    }
}
