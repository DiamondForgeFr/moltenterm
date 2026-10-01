// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoltenApi } from "./molten-api";
import { MoltenActivateTimeoutMs, MoltenHost, MoltenHostEnv } from "./molten-host";

const ModsDir = "/cfg/mods";
const StateFile = "/cfg/molten/mods.json";

type FakeMod = { manifest?: any; manifestText?: string; module?: any; importError?: Error };

function manifestFor(id: string, extra?: any) {
    return { id, name: id, version: "1.0.0", apiVersion: 1, main: "main.js", ...extra };
}

// `enabled` defaults to every mod; tests that change it keep the holder and mutate `ids`.
function makeEnv(mods: Record<string, FakeMod>, extraDirs: string[] = [], enabled?: { ids: string[] }): MoltenHostEnv {
    return {
        modsDir: ModsDir,
        stateFile: StateFile,
        listDir: async () => [
            ...Object.keys(mods).map((name) => ({ name, isDir: true })),
            ...extraDirs.map((name) => ({ name, isDir: true })),
            { name: "notes.txt", isDir: false },
        ],
        readTextFile: async (path: string) => {
            if (path === StateFile) {
                return JSON.stringify({ enabled: enabled?.ids ?? Object.keys(mods) });
            }
            const [id, file] = path.slice(ModsDir.length + 1).split("/");
            const mod = mods[id];
            if (mod == null) {
                return null;
            }
            if (file === "mod.json") {
                if (mod.manifestText != null) {
                    return mod.manifestText;
                }
                return mod.manifest == null ? null : JSON.stringify(mod.manifest);
            }
            return "// source";
        },
        importModule: async (_source: string, sourceName: string) => {
            const mod = mods[sourceName.split("/")[0]];
            if (mod.importError) {
                throw mod.importError;
            }
            return mod.module;
        },
        writeClipboard: vi.fn(async () => {}),
    };
}

function modState(host: MoltenHost, id: string) {
    return host.listMods().mods.find((m) => m.id === id);
}

let host: MoltenHost;

beforeEach(() => {
    MoltenHost.resetInstance();
    host = MoltenHost.getInstance();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("MoltenHost", () => {
    it("loads a valid mod and isolates one whose activate throws (TC-MORPH-001)", async () => {
        const env = makeEnv({
            good: {
                manifest: manifestFor("good"),
                module: { activate: (api: MoltenApi) => api.commands.register("hello", () => "hi") },
            },
            broken: {
                manifest: manifestFor("broken"),
                module: {
                    activate: (api: MoltenApi) => {
                        api.commands.register("leftover", () => "never");
                        throw new Error("boom");
                    },
                },
            },
        });
        await host.start(env);

        expect(modState(host, "good")).toMatchObject({ state: "active", commands: ["hello"] });
        expect(modState(host, "broken")).toMatchObject({ state: "failed", error: "activate: boom", commands: [] });
        expect(host.commands.has("leftover")).toBe(false);
        expect(host.commands.has("hello")).toBe(true);
        const notifications = globalStore.get(host.notificationsAtom);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            kind: "error",
            title: 'Mod "broken" stopped',
            message: "activate: boom",
        });
    });

    it("lists only folders, in name order, and reports the mods directory", async () => {
        await host.start(makeEnv({ zeta: { manifest: manifestFor("zeta"), module: { activate() {} } } }, [".hidden"]));
        const list = host.listMods();
        expect(list).toMatchObject({ apiversions: [1], safemode: false, modsdir: ModsDir });
        expect(list.mods.map((m) => m.id)).toEqual(["zeta"]);
    });

    it("stops a mod whose handler throws later and undoes its registrations in reverse order", async () => {
        const order: string[] = [];
        let api: MoltenApi;
        await host.start(
            makeEnv({
                flaky: {
                    manifest: manifestFor("flaky"),
                    module: {
                        activate(a: MoltenApi) {
                            api = a;
                            a.commands.register("first", () => "ok");
                            a.commands.register("explode", () => {
                                throw new Error("handler failed");
                            });
                        },
                    },
                },
            })
        );
        const spyDelete = vi.spyOn(host.commands, "delete").mockImplementation(function (this: Map<any, any>, k) {
            order.push(k);
            return Map.prototype.delete.call(this, k);
        });

        await expect(host.commands.get("explode").handler({ args: [] })).rejects.toThrow("handler failed");

        expect(order).toEqual(["explode", "first"]);
        expect(modState(host, "flaky")).toMatchObject({ state: "failed", error: "handler failed", commands: [] });
        expect(() => api.commands.register("again", () => "")).toThrow('mod "flaky" is stopped');
        spyDelete.mockRestore();
    });

    it("refuses an unsupported api version and names the supported ones", async () => {
        await host.start(makeEnv({ future: { manifest: manifestFor("future", { apiVersion: 2 }) } }));
        expect(modState(host, "future")).toMatchObject({
            state: "refused",
            error: "apiVersion 2 is not supported; supported versions: 1",
        });
        expect(globalStore.get(host.notificationsAtom)[0]).toMatchObject({ kind: "warning" });
    });

    it.each([
        ["a missing mod.json", { manifest: undefined }, "mod.json not found"],
        ["invalid JSON", { manifestText: "{" }, "mod.json is not valid JSON"],
        ["an import error", { importError: new SyntaxError("Unexpected token") }, "loading main.js: Unexpected token"],
        ["no activate export", { module: { default: () => {} } }, "main.js does not export an activate(api) function"],
    ])("reports %s", async (_label, fake: FakeMod, error) => {
        await host.start(makeEnv({ bad: { manifest: manifestFor("bad"), ...fake } }));
        expect(modState(host, "bad").state).toBe("failed");
        expect(modState(host, "bad").error).toContain(error);
    });

    it("refuses a command name another mod already registered", async () => {
        await host.start(
            makeEnv({
                a: {
                    manifest: manifestFor("a"),
                    module: { activate: (api: MoltenApi) => api.commands.register("x", () => "") },
                },
                b: {
                    manifest: manifestFor("b"),
                    module: { activate: (api: MoltenApi) => api.commands.register("x", () => "") },
                },
            })
        );
        expect(modState(host, "a").state).toBe("active");
        expect(modState(host, "b").error).toBe('activate: command "x" is already registered by mod "a"');
        expect(host.commands.get("x").modId).toBe("a");
    });

    it("refuses reserved and malformed command names", async () => {
        await host.start(
            makeEnv({
                r: {
                    manifest: manifestFor("r"),
                    module: { activate: (api: MoltenApi) => api.commands.register("undo", () => "") },
                },
                m: {
                    manifest: manifestFor("m"),
                    module: { activate: (api: MoltenApi) => api.commands.register("Bad Name", () => "") },
                },
            })
        );
        expect(modState(host, "r").error).toContain('"undo" is reserved');
        expect(modState(host, "m").error).toContain("command name must use");
    });

    it("stops a mod whose activate never finishes", async () => {
        vi.useFakeTimers();
        const started = host.start(
            makeEnv({ slow: { manifest: manifestFor("slow"), module: { activate: () => new Promise(() => {}) } } })
        );
        await vi.advanceTimersByTimeAsync(MoltenActivateTimeoutMs + 1);
        await started;
        expect(modState(host, "slow").error).toBe("activate: activate did not finish within 10 s");
    });

    it("gives mods notifications and the clipboard, and removes a stopped mod's notifications", async () => {
        const env = makeEnv({
            n: {
                manifest: manifestFor("n"),
                module: {
                    async activate(api: MoltenApi) {
                        api.notifications.show({ title: "Hello", kind: "error" });
                        await api.clipboard.writeText("copied");
                        api.commands.register("fail", () => {
                            throw new Error("bye");
                        });
                    },
                },
            },
        });
        await host.start(env);
        expect(env.writeClipboard).toHaveBeenCalledWith("copied");
        expect(globalStore.get(host.notificationsAtom).map((n) => n.title)).toEqual(["Hello"]);

        await expect(host.commands.get("fail").handler({ args: [] })).rejects.toThrow("bye");
        expect(globalStore.get(host.notificationsAtom).map((n) => n.title)).toEqual(['Mod "n" stopped']);
    });

    it("loads no mod in safe mode", async () => {
        const env = makeEnv({ good: { manifest: manifestFor("good"), module: { activate() {} } } });
        const listDir = vi.spyOn(env, "listDir");
        await host.start(env, { safeMode: true });
        expect(listDir).not.toHaveBeenCalled();
        expect(host.listMods()).toMatchObject({ safemode: true, mods: [] });
    });

    it("reports an unreadable mods directory without throwing", async () => {
        const env = makeEnv({});
        env.listDir = async () => {
            throw new Error("rpc down");
        };
        await host.start(env);
        expect(globalStore.get(host.notificationsAtom)[0]).toMatchObject({
            kind: "error",
            title: "Mods could not be read",
            message: "rpc down",
        });
    });

    it("starts only once", async () => {
        const env = makeEnv({ good: { manifest: manifestFor("good"), module: { activate() {} } } });
        const listDir = vi.spyOn(env, "listDir");
        await host.start(env);
        await host.start(env);
        expect(listDir).toHaveBeenCalledTimes(1);
    });

    it("reports mods that are not enabled as disabled and reads none of their code", async () => {
        const env = makeEnv(
            {
                on: { manifest: manifestFor("on"), module: { activate() {} } },
                off: { manifest: manifestFor("off"), module: { activate() {} } },
            },
            [],
            { ids: ["on"] }
        );
        const importModule = vi.spyOn(env, "importModule");
        await host.start(env);
        expect(modState(host, "on").state).toBe("active");
        expect(modState(host, "off")).toMatchObject({ state: "disabled", commands: [] });
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(host.listMods().mods.map((m) => m.id)).toEqual(["off", "on"]);
    });

    it("treats a missing state file as nothing enabled", async () => {
        const env = makeEnv({ a: { manifest: manifestFor("a"), module: { activate() {} } } });
        env.readTextFile = async () => null;
        await host.start(env);
        expect(modState(host, "a").state).toBe("disabled");
    });

    it("enables, disables and removes mods on reload without a failure notification", async () => {
        const enabled = { ids: [] as string[] };
        const mods: Record<string, FakeMod> = {
            a: {
                manifest: manifestFor("a"),
                module: { activate: (api: MoltenApi) => api.commands.register("say", () => "a") },
            },
        };
        await host.start(makeEnv(mods, [], enabled));
        expect(modState(host, "a").state).toBe("disabled");

        enabled.ids = ["a"];
        await host.reload(["a"]);
        expect(modState(host, "a")).toMatchObject({ state: "active", commands: ["say"] });

        enabled.ids = [];
        await host.reload(["a"]);
        expect(modState(host, "a").state).toBe("disabled");
        expect(host.commands.has("say")).toBe(false);

        delete mods.a;
        await host.reload(["a"]);
        expect(modState(host, "a")).toBeUndefined();
        expect(globalStore.get(host.notificationsAtom)).toEqual([]);
    });

    it("reloads every mod when no id is given", async () => {
        const activations: string[] = [];
        const mods: Record<string, FakeMod> = {
            a: { manifest: manifestFor("a"), module: { activate: () => void activations.push("a") } },
            b: { manifest: manifestFor("b"), module: { activate: () => void activations.push("b") } },
        };
        await host.start(makeEnv(mods));
        await host.reload(null);
        expect(activations).toEqual(["a", "b", "a", "b"]);
    });

    it("runs mod commands and passes their output and exit code", async () => {
        await host.start(
            makeEnv({
                c: {
                    manifest: manifestFor("c"),
                    module: {
                        activate(api: MoltenApi) {
                            api.commands.register(
                                "echo",
                                ({ args, stdin, blockId }) => `${args.join(" ")}|${stdin}|${blockId}`,
                                {
                                    description: "Echo",
                                }
                            );
                            api.commands.register("code", () => ({ output: "out", exitCode: 3 }));
                            api.commands.register("quiet", () => {});
                            api.commands.register("boom", () => {
                                throw new Error("kaput");
                            });
                        },
                    },
                },
            })
        );
        expect(await host.runCommand({ command: "echo", args: ["a", "b"], stdin: "in", blockid: "blk" })).toEqual({
            found: true,
            output: "a b|in|blk",
            exitcode: 0,
        });
        expect(await host.runCommand({ command: "code" })).toEqual({ found: true, output: "out", exitcode: 3 });
        expect(await host.runCommand({ command: "quiet" })).toEqual({ found: true, output: "", exitcode: 0 });
        expect(host.listMods().commands).toContainEqual({ name: "echo", modid: "c", description: "Echo" });
        expect(await host.runCommand({ command: "nope" })).toEqual({
            found: false,
            commands: ["boom", "code", "echo", "quiet"],
        });
        expect(await host.runCommand({ command: "boom" })).toEqual({
            found: true,
            output: "",
            exitcode: 1,
            error: "kaput",
        });
        expect(modState(host, "c").state).toBe("failed");
    });
});
