// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The installer of the in-app update of a release (#1860) against a local server with fake files and a fake release
// key: every refusal happens before anything is staged, armed or kept, and says why. Nothing here reads the real release
// key or reaches GitHub; waiting is on the installer's own end signal, never on a clock.

import { createHash } from "crypto";
import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    releaseFileName,
    ReleaseInstallPlan,
    ReleaseInstallState,
} from "../frontend/moltenterm-shell/update/release-install";
import { readReleaseKey } from "./moltenterm-openpgp";
import { FakeSignedAt, makeFakeKey } from "./moltenterm-openpgp-testkit";
import { InstallDeps, ReleaseInstaller, StageFn } from "./moltenterm-release-install-core";

const Version = "1.0.0-9";
const Tag = `v${Version}`;
const Offer = { tag: Tag, version: Version };
const SwapPlan: ReleaseInstallPlan = { mode: "swap", kind: "zip" };
const DownloadPlan: ReleaseInstallPlan = { mode: "download", reason: "package", kind: "deb" };
const FileName = releaseFileName("zip", "darwin", "arm64", Version);
const DebName = releaseFileName("deb", "linux", "x64", Version);

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) {
        await c();
    }
});

function sha(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

async function serve(routes: Record<string, Route>, dead = false): Promise<string> {
    const server = http.createServer((req, res) => {
        const route = routes[req.url ?? ""];
        if (route == null) {
            res.writeHead(404).end();
            return;
        }
        route(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const close = async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    if (dead) {
        await close();
        return base;
    }
    cleanups.push(close);
    return base;
}

const send =
    (body: Buffer | string, status = 200): Route =>
    (_req, res) => {
        res.writeHead(status, { "content-length": Buffer.byteLength(body) });
        res.end(body);
    };

type Setup = {
    sums?: string;
    signWith?: ReturnType<typeof makeFakeKey>;
    sumsSent?: string;
    signature?: string | null;
    file?: Buffer;
    fileSent?: Route;
    plan?: ReleaseInstallPlan;
    stage?: StageFn;
    stallMs?: number;
    sumsRoute?: Route;
    dead?: boolean;
};

async function fixture(setup: Setup = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-install-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const key = makeFakeKey();
    const readKey = readReleaseKey(key.armoredPublic);
    const plan = setup.plan ?? SwapPlan;
    const name = plan.mode === "download" ? DebName : FileName;
    const file = setup.file ?? Buffer.alloc(3 * 1024 * 1024, 7);
    const sums = setup.sums ?? `${sha(file)}  ${name}\n${"a".repeat(64)}  other-file.zip\n`;
    const signer = setup.signWith ?? key;
    const signature = signer.sign(Buffer.from(sums), { signedAt: FakeSignedAt });
    const routes: Record<string, Route> = {
        [`/${Tag}/SHA256SUMS.txt`]: setup.sumsRoute ?? send(setup.sumsSent ?? sums),
        [`/${Tag}/${name}`]: setup.fileSent ?? send(file),
    };
    if (setup.signature !== null) {
        routes[`/${Tag}/SHA256SUMS.txt.asc`] = send(setup.signature ?? signature);
    }
    const base = await serve(routes, setup.dead);
    const states: ReleaseInstallState[] = [];
    const calls = { staged: [] as string[], armed: 0, disarmed: 0, now: 0, revealed: [] as string[] };
    const workDirs: string[] = [];
    const deps: InstallDeps = {
        fetch: (url, init) => fetch(url, init),
        key: readKey,
        env: { MOLTENTERM_BACKGROUND: "1", MOLTENTERM_RELEASE_DOWNLOAD_URL: base },
        platform: plan.mode === "download" ? "linux" : "darwin",
        arch: plan.mode === "download" ? "x64" : "arm64",
        plan,
        workDir: (version) => {
            const d = path.join(dir, "release", version);
            workDirs.push(d);
            return d;
        },
        downloadsDir: () => path.join(dir, "Downloads"),
        stage:
            setup.stage ??
            (async (staged) => {
                calls.staged.push(fs.readFileSync(staged.file).length + ":" + staged.sha256);
                return { ok: true, swap: { name: "fake.sh", script: "", label: staged.version, args: () => [] } };
            }),
        arm: () => {
            calls.armed++;
        },
        disarm: () => {
            calls.disarmed++;
        },
        swapNow: () => {
            calls.now++;
        },
        reveal: (f) => calls.revealed.push(f),
        publish: (s) => states.push(s),
        nowMs: () => (FakeSignedAt + 10) * 1000,
        stallMs: setup.stallMs,
    };
    const installer = new ReleaseInstaller(deps);
    cleanups.push(() => installer.whenDone());
    return { installer, states, calls, dir, file, name, workDir: () => path.join(dir, "release", Version), base };
}

async function runOffer(f: Awaited<ReturnType<typeof fixture>>) {
    expect(f.installer.start(Offer)).toEqual({ ok: true });
    await f.installer.whenDone();
    return f.installer.getState();
}

describe("a good release", () => {
    it("downloads, verifies, stages and arms the update for the quit", async () => {
        const f = await fixture();
        const state = await runOffer(f);
        expect(state).toMatchObject({ phase: "ready", mode: "swap", armed: true, tag: Tag, version: Version });
        expect(f.calls.staged).toEqual([`${f.file.length}:${sha(f.file)}`]);
        expect(f.calls.armed).toBe(1);
        const phases = f.states.map((s) => s.phase).filter((p, i, all) => all[i - 1] !== p);
        expect(phases).toEqual(["downloading", "verifying", "ready"]);
        expect(fs.existsSync(path.join(f.workDir(), f.name))).toBe(true);
    });

    it("restarts now or leaves it for the quit, only once it is staged", async () => {
        const f = await fixture();
        expect(f.installer.apply("now")).toMatchObject({ ok: false });
        await runOffer(f);
        expect(f.installer.apply("quit")).toEqual({ ok: true });
        expect(f.calls.armed).toBe(2);
        const disarmedBefore = f.calls.disarmed;
        expect(f.installer.apply("now")).toEqual({ ok: true });
        expect(f.calls.now).toBe(1);
        // Restarting now takes the quit's own swap away: two swaps of the same staged files would race.
        expect(f.calls.disarmed).toBe(disarmedBefore + 1);
    });

    it("keeps a file it cannot install on its own in Downloads, verified, and shows it on request", async () => {
        const f = await fixture({ plan: DownloadPlan });
        const state = await runOffer(f);
        expect(state).toMatchObject({ phase: "ready", mode: "download" });
        expect(state.file).toBe(path.join(f.dir, "Downloads", f.name));
        expect(fs.readFileSync(state.file).equals(f.file)).toBe(true);
        expect(fs.existsSync(f.workDir())).toBe(false);
        expect(f.calls.staged).toEqual([]);
        expect(f.calls.armed).toBe(0);
        expect(f.installer.apply("now")).toMatchObject({ ok: false });
        expect(f.installer.reveal()).toEqual({ ok: true });
        expect(f.calls.revealed).toEqual([state.file]);
    });

    it("answers the same offer twice with one download", async () => {
        const f = await fixture();
        expect(f.installer.start(Offer)).toEqual({ ok: true });
        expect(f.installer.start(Offer)).toEqual({ ok: true });
        await f.installer.whenDone();
        expect(f.installer.start(Offer)).toEqual({ ok: true });
        expect(f.calls.staged.length).toBe(1);
    });

    it("withdraws a staged update that is no longer offered", async () => {
        const f = await fixture();
        await runOffer(f);
        f.installer.forget();
        expect(f.installer.getState()).toEqual({ phase: "idle" });
        expect(f.calls.disarmed).toBeGreaterThan(0);
        expect(f.installer.apply("now")).toMatchObject({ ok: false });
    });
});

describe("refusals", () => {
    async function refused(setup: Setup, kind: string, detail?: RegExp) {
        const f = await fixture(setup);
        const state = await runOffer(f);
        expect(state.phase).toBe("error");
        expect(state.error.kind).toBe(kind);
        if (detail) {
            expect(state.error.detail).toMatch(detail);
        }
        expect(f.calls.staged).toEqual([]);
        expect(f.calls.armed).toBe(0);
        expect(fs.existsSync(f.workDir())).toBe(false);
        expect(fs.existsSync(path.join(f.dir, "Downloads"))).toBe(false);
        return f;
    }

    it("a file that is not the one the signed list names", async () => {
        const file = Buffer.alloc(2048, 7);
        const tampered = Buffer.from(file);
        tampered[100] = 8;
        await refused({ file, fileSent: send(tampered) }, "checksum");
    });

    it("a checksum list changed after it was signed", async () => {
        const file = Buffer.alloc(2048, 7);
        const real = `${sha(file)}  ${FileName}\n`;
        const forged = `${sha(Buffer.from("evil"))}  ${FileName}\n`;
        await refused({ sums: real, sumsSent: forged, file }, "signature", /does not match/);
    });

    it("a list signed by another key", async () => {
        await refused({ signWith: makeFakeKey() }, "signature", /not by the DiamondForge release key/);
    });

    it("a release without a signature", async () => {
        await refused({ signature: null }, "unsigned");
    });

    it("a signature that is not a signature", async () => {
        await refused({ signature: "not a signature" }, "signature", /cannot be read/);
    });

    it("a release without checksums, and a file the list does not name", async () => {
        await refused({ sumsRoute: (_req, res) => res.writeHead(404).end() }, "missing");
        await refused({ sums: `${"b".repeat(64)}  something-else.zip\n` }, "missing", new RegExp(FileName));
    });

    it("a malformed list", async () => {
        await refused({ sums: `not a checksum list\n` }, "checksum", /malformed/);
        await refused(
            { sums: `${"c".repeat(64)}  ${FileName}\n${"d".repeat(64)}  ${FileName}\n` },
            "checksum",
            /malformed/
        );
    });

    it("a file that is not published, and a server in trouble", async () => {
        await refused({ fileSent: (_req, res) => res.writeHead(404).end() }, "missing");
        await refused({ fileSent: (_req, res) => res.writeHead(500).end() }, "network", /500/);
    });

    it("a file too big to be one, announced before any byte is read", async () => {
        await refused(
            {
                fileSent: (_req, res) => {
                    res.writeHead(200, { "content-length": String(2 * 1024 * 1024 * 1024) });
                    res.flushHeaders();
                },
            },
            "toolarge"
        );
    });

    it("a download that stalls", async () => {
        await refused(
            {
                stallMs: 300,
                fileSent: (_req, res) => {
                    res.writeHead(200, { "content-length": "100000" });
                    res.write(Buffer.alloc(10));
                },
            },
            "network",
            /no data/
        );
    });

    it("a platform step that judges the file unfit", async () => {
        const f = await fixture({
            stage: async () => ({ ok: false, error: { kind: "codesign", detail: "the app is not signed" } }),
        });
        const state = await runOffer(f);
        expect(state).toMatchObject({ phase: "error", error: { kind: "codesign" } });
        expect(f.calls.armed).toBe(0);
        expect(fs.existsSync(f.workDir())).toBe(false);
    });

    it("a server that is not there", async () => {
        await refused({ dead: true }, "network");
    });
});

describe("what it will not start", () => {
    it("an install it cannot act on, an offer whose tag is not its version, and a second release meanwhile", async () => {
        const none = await fixture({ plan: { mode: "none", reason: "platform" } });
        expect(none.installer.start(Offer)).toMatchObject({ ok: false, error: { kind: "unsupported" } });
        const f = await fixture({
            fileSent: (_req, res) => {
                res.writeHead(200, { "content-length": "100000" });
                res.write(Buffer.alloc(10));
            },
            stallMs: 200,
        });
        expect(f.installer.start({ tag: "v1.0.0-9", version: "1.0.0-8" })).toMatchObject({
            ok: false,
            error: { kind: "stale" },
        });
        expect(f.installer.start(Offer)).toEqual({ ok: true });
        expect(f.installer.start({ tag: "v1.0.0-10", version: "1.0.0-10" })).toMatchObject({
            ok: false,
            error: { kind: "busy" },
        });
        await f.installer.whenDone();
    });

    it("gives up a download on request and goes back to idle", async () => {
        let started: () => void;
        const begun = new Promise<void>((resolve) => (started = resolve));
        const f = await fixture({
            fileSent: (_req, res) => {
                res.writeHead(200, { "content-length": "100000" });
                res.write(Buffer.alloc(10));
                started();
            },
        });
        expect(f.installer.start(Offer)).toEqual({ ok: true });
        await begun;
        f.installer.cancel();
        await f.installer.whenDone();
        expect(f.installer.getState()).toEqual({ phase: "idle" });
        expect(f.calls.armed).toBe(0);
    });

    it("the user's Cancel stops only a download in flight (#2163)", async () => {
        let started: () => void;
        const begun = new Promise<void>((resolve) => (started = resolve));
        const f = await fixture({
            fileSent: (_req, res) => {
                res.writeHead(200, { "content-length": "100000" });
                res.write(Buffer.alloc(10));
                started();
            },
        });
        expect(f.installer.cancelDownload()).toMatchObject({ ok: false, error: { kind: "stale" } });
        expect(f.installer.start(Offer)).toEqual({ ok: true });
        await begun;
        expect(f.installer.cancelDownload()).toEqual({ ok: true });
        await f.installer.whenDone();
        expect(f.installer.getState()).toEqual({ phase: "idle" });
        expect(f.calls.armed).toBe(0);
    });
});
