// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Revoking a mod's trust (FR-MORPH-004, #1880) and the trust each mod reports. The host runs against an in-memory
// copy of the three places it reads: the mod folders, mods.json and trust.json.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoltenApi } from "./molten-api";
import { MoltenHost, MoltenHostEnv } from "./molten-host";

const ModsDir = "/cfg/mods";
const StateFile = "/cfg/molten/mods.json";
const TrustFile = "/data/molten/trust.json";

type Files = Map<string, string>;

type Fake = {
    env: MoltenHostEnv;
    files: Files;
    writes: string[];
};

function modJson(id: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1, main: "main.js", ...extra });
}

function makeFake(options: { builtins?: boolean; failWrite?: string } = {}): Fake {
    const files: Files = new Map();
    const writes: string[] = [];
    const folders = ["clock", "idle", "pack", "ghost"];
    for (const id of ["clock", "idle", "ghost"]) {
        files.set(`${ModsDir}/${id}/mod.json`, modJson(id));
        files.set(`${ModsDir}/${id}/main.js`, "// source");
    }
    files.set(
        `${ModsDir}/pack/mod.json`,
        JSON.stringify({
            id: "pack",
            name: "Pack",
            version: "1.0.0",
            apiVersion: 1,
            languages: [{ code: "xx", name: "Xx", file: "xx.json" }],
        })
    );
    files.set(
        StateFile,
        JSON.stringify({ enabled: ["clock", "ghost"], disabled: [], enabledat: { clock: "2026-11-02T10:30:01Z" } })
    );
    files.set(
        TrustFile,
        JSON.stringify({
            trusted: {
                clock: { name: "clock", trustedat: "2026-11-02T10:30:00Z" },
                idle: { name: "idle", trustedat: "2026-10-20T08:00:00Z" },
            },
        })
    );
    const env: MoltenHostEnv = {
        modsDir: ModsDir,
        stateFile: StateFile,
        trustFile: TrustFile,
        listDir: async () => folders.map((name) => ({ name, isDir: true })),
        readTextFile: async (path) => files.get(path) ?? null,
        writeTextFile: async (path, text) => {
            if (path === options.failWrite) {
                throw new Error("disk full");
            }
            writes.push(path);
            files.set(path, text);
        },
        importModule: async (_source, sourceName) => ({
            activate: (api: MoltenApi) => {
                api.commands.register(sourceName.split("/")[0], () => "tick");
            },
        }),
        writeClipboard: async () => {},
    };
    if (options.builtins) {
        env.builtins = [{ id: "copy-box", files: { "mod.json": modJson("copy-box"), "main.js": "" } }];
    }
    return { env, files, writes };
}

function status(host: MoltenHost, id: string) {
    return host.listMods().mods.find((m) => m.id === id);
}

let host: MoltenHost;

beforeEach(() => {
    MoltenHost.resetInstance();
    host = MoltenHost.getInstance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the trust each mod reports", () => {
    it("tells when the user trusted a mod, and that another was not", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        expect(status(host, "clock")).toMatchObject({
            state: "active",
            trusted: true,
            trustedat: "2026-11-02T10:30:00Z",
        });
        expect(status(host, "idle")).toMatchObject({
            state: "disabled",
            trusted: true,
            trustedat: "2026-10-20T08:00:00Z",
        });
        expect(status(host, "ghost")).toMatchObject({ state: "untrusted", trusted: false });
    });

    it("says nothing for a mod that asks for no trust", async () => {
        const fake = makeFake({ builtins: true });
        await host.start(fake.env);
        expect(status(host, "pack").trusted).toBeUndefined();
        expect(status(host, "pack").trustedat).toBeUndefined();
        expect(status(host, "copy-box").trusted).toBeUndefined();
    });

    it("reports it in a view that does not show yet", async () => {
        const fake = makeFake({ builtins: true });
        host.showing = false;
        await host.start(fake.env);
        expect(status(host, "clock")).toMatchObject({ state: "pending", trusted: true });
        expect(status(host, "ghost")).toMatchObject({ state: "untrusted", trusted: false });
        expect(status(host, "pack").trusted).toBeUndefined();
        expect(status(host, "copy-box").trusted).toBeUndefined();
    });

    it("reports it in safe mode, where no code runs", async () => {
        const fake = makeFake();
        await host.start(fake.env, { safeMode: true });
        expect(status(host, "clock")).toMatchObject({ state: "safemode", trusted: true });
        expect(status(host, "idle")).toMatchObject({ state: "disabled", trusted: true });
        expect(status(host, "ghost")).toMatchObject({ state: "safemode", trusted: false });
        expect(status(host, "pack").trusted).toBeUndefined();
    });
});

describe("revokeTrust", () => {
    it("stops the mod at once, forgets its trust and its enabled state, and keeps every other mod's", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        expect(host.commands.has("clock")).toBe(true);

        await host.revokeTrust("clock");

        expect(status(host, "clock")).toMatchObject({ state: "disabled", trusted: false, commands: [] });
        expect(status(host, "clock").trustedat).toBeUndefined();
        expect(host.commands.has("clock")).toBe(false);
        expect(JSON.parse(fake.files.get(TrustFile))).toEqual({
            trusted: { idle: { name: "idle", trustedat: "2026-10-20T08:00:00Z" } },
        });
        expect(JSON.parse(fake.files.get(StateFile))).toEqual({ enabled: ["ghost"], disabled: [] });
        expect(status(host, "idle")).toMatchObject({ trusted: true });
    });

    it("runs the mod's disposers, so its page and timers go with it", async () => {
        const fake = makeFake();
        const releasePage = vi.fn(() => 0);
        fake.env.page = { release: releasePage };
        await host.start(fake.env);

        await host.revokeTrust("clock");

        expect(releasePage).toHaveBeenCalledWith("clock");
        expect(host.isRunning("clock")).toBe(false);
    });

    it("does not run the mod again when mods.json lists it without a trust record", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        await host.revokeTrust("clock");
        fake.files.set(StateFile, JSON.stringify({ enabled: ["clock", "ghost"] }));
        await host.reload(["clock"]);
        expect(status(host, "clock")).toMatchObject({ state: "untrusted", trusted: false });
        expect(host.commands.has("clock")).toBe(false);
    });

    it("writes the files as molten does", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        await host.revokeTrust("clock");
        expect(fake.files.get(TrustFile)).toBe(
            '{\n  "trusted": {\n    "idle": {\n      "name": "idle",\n      "trustedat": "2026-10-20T08:00:00Z"\n    }\n  }\n}\n'
        );
        expect(fake.files.get(StateFile).endsWith("\n")).toBe(true);
    });

    it("stops a mod that is enabled in mods.json without a trust record, and writes only the file that changes", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        await host.revokeTrust("ghost");
        expect(fake.writes).toEqual([StateFile]);
        expect(JSON.parse(fake.files.get(StateFile)).enabled).toEqual(["clock"]);
        expect(status(host, "ghost")).toMatchObject({ state: "disabled", trusted: false });
    });

    it("changes nothing for a mod that is neither trusted nor enabled, and says nothing is wrong", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        await host.revokeTrust("pack");
        expect(fake.writes).toEqual([]);
    });

    it("stops the mod in a view that does not show", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        host.setShowing(false);
        expect(host.isRunning("clock")).toBe(true);

        await host.revokeTrust("clock");

        expect(host.isRunning("clock")).toBe(false);
        expect(status(host, "clock")).toMatchObject({ state: "disabled", trusted: false });
    });

    it("lists the mods again in safe mode, where no code is loaded", async () => {
        const fake = makeFake();
        await host.start(fake.env, { safeMode: true });
        await host.revokeTrust("clock");
        expect(status(host, "clock")).toMatchObject({ state: "disabled", trusted: false });
        expect(host.commands.size).toBe(0);
    });

    it("refuses a built-in mod, an unknown mod and a window that cannot write", async () => {
        const fake = makeFake({ builtins: true });
        await host.start(fake.env);
        await expect(host.revokeTrust("copy-box")).rejects.toThrow('the trust of "copy-box" cannot be revoked here');
        await expect(host.revokeTrust("nope")).rejects.toThrow('the trust of "nope" cannot be revoked here');
        expect(fake.writes).toEqual([]);

        MoltenHost.resetInstance();
        const readOnly = makeFake();
        delete readOnly.env.writeTextFile;
        host = MoltenHost.getInstance();
        await host.start(readOnly.env);
        await expect(host.revokeTrust("clock")).rejects.toThrow('the trust of "clock" cannot be revoked here');
        expect(host.isRunning("clock")).toBe(true);
    });

    it("reports a trust file that is not valid JSON and leaves both files as they were", async () => {
        const fake = makeFake();
        await host.start(fake.env);
        fake.files.set(TrustFile, "{oops");
        const state = fake.files.get(StateFile);

        await expect(host.revokeTrust("clock")).rejects.toThrow(`${TrustFile} is not valid JSON`);

        expect(fake.files.get(TrustFile)).toBe("{oops");
        expect(fake.files.get(StateFile)).toBe(state);
        expect(fake.writes).toEqual([]);
    });

    it("reports a write that fails, and the mod stops all the same once its trust is gone", async () => {
        const fake = makeFake({ failWrite: StateFile });
        await host.start(fake.env);

        await expect(host.revokeTrust("clock")).rejects.toThrow("disk full");

        expect(JSON.parse(fake.files.get(TrustFile)).trusted.clock).toBeUndefined();
        expect(status(host, "clock")).toMatchObject({ state: "untrusted", trusted: false });
        expect(host.isRunning("clock")).toBe(false);
    });

    it("keeps the mod running when its trust could not be forgotten", async () => {
        const fake = makeFake({ failWrite: TrustFile });
        await host.start(fake.env);

        await expect(host.revokeTrust("clock")).rejects.toThrow("disk full");

        expect(status(host, "clock")).toMatchObject({ state: "active", trusted: true });
        expect(JSON.parse(fake.files.get(StateFile)).enabled).toContain("clock");
    });
});
