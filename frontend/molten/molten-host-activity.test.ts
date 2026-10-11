// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-PERF-014: mods load where they are needed, are measured against their budget, and two mods registering the same
// command get an error naming both. The mods here are real modules, imported from their source as the app does, so the
// timers they call are the host's.

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoltenBudgetCheckMs } from "./molten-budget";
import { MoltenHost, MoltenHostEnv } from "./molten-host";

const ModsDir = "/cfg/mods";
const StateFile = "/cfg/molten/mods.json";
const TrustFile = "/data/molten/trust.json";

type SourceMod = { source: string; capabilities?: string[] };

// What the mods report to the test: they run in their own module scope, so they reach it through globalThis.
type Probe = { ticks: Record<string, number>; hooks: string[]; busyMs: number };

function probe(): Probe {
    return (globalThis as any).__moltenTestProbe;
}

// The clock both the host and the mods' busy work use: a busy callback advances it instead of spinning.
const clock = { t: 0 };

function makeEnv(
    mods: Record<string, SourceMod>,
    enabled: { ids: string[] },
    builtins: Record<string, SourceMod> = {}
) {
    const importModule = vi.fn(async (source: string) => {
        return import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
    });
    const manifest = (id: string, m: SourceMod) =>
        JSON.stringify({
            id,
            name: id,
            version: "1.0.0",
            apiVersion: 1,
            main: "main.js",
            capabilities: m.capabilities ?? [],
        });
    const env: MoltenHostEnv = {
        modsDir: ModsDir,
        stateFile: StateFile,
        trustFile: TrustFile,
        listDir: async () => Object.keys(mods).map((name) => ({ name, isDir: true })),
        readTextFile: async (path: string) => {
            if (path === StateFile) {
                return JSON.stringify({ enabled: enabled.ids });
            }
            if (path === TrustFile) {
                return JSON.stringify({ trusted: Object.fromEntries(Object.keys(mods).map((id) => [id, {}])) });
            }
            const [id, file] = path.slice(ModsDir.length + 1).split("/");
            const mod = mods[id];
            if (mod == null) {
                return null;
            }
            return file === "mod.json" ? manifest(id, mod) : mod.source;
        },
        importModule,
        writeClipboard: async () => {},
        builtins: Object.entries(builtins).map(([id, m]) => ({
            id,
            files: { "mod.json": manifest(id, m), "main.js": m.source },
        })),
        clock: {
            now: () => clock.t,
            setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
            clearTimeout: (handle) => globalThis.clearTimeout(handle),
        },
        heapUsedMB: () => null,
    };
    return { env, importModule };
}

// A mod with an interval that counts its ticks and, when busyMs is set, keeps the CPU that long on each.
function tickingMod(id: string, ms: number, command = id): SourceMod {
    return {
        source: `export function activate(api) {
    api.commands.register(${JSON.stringify(command)}, () => "ok");
    setInterval(() => {
        const p = globalThis.__moltenTestProbe;
        p.ticks[${JSON.stringify(id)}] = (p.ticks[${JSON.stringify(id)}] ?? 0) + 1;
        globalThis.__moltenTestClock.t += p.busyMs;
    }, ${ms});
}
export function suspend() { globalThis.__moltenTestProbe.hooks.push(${JSON.stringify(id + ":suspend")}); }
export function resume() { globalThis.__moltenTestProbe.hooks.push(${JSON.stringify(id + ":resume")}); }
`,
    };
}

function commandMod(command: string, catchConflict = false): SourceMod {
    const register = `api.commands.register(${JSON.stringify(command)}, () => "mine")`;
    return {
        source: `export function activate(api) { ${catchConflict ? `try { ${register}; } catch (e) {}` : register} }`,
    };
}

// Advances the fake timers and the host's clock together.
function advance(ms: number, step = 100) {
    for (let done = 0; done < ms; done += step) {
        clock.t += step;
        vi.advanceTimersByTime(step);
    }
}

function modState(host: MoltenHost, id: string) {
    return host.snapshot().find((m) => m.id === id);
}

let host: MoltenHost;

beforeEach(() => {
    MoltenHost.resetInstance();
    host = MoltenHost.getInstance();
    clock.t = 0;
    (globalThis as any).__moltenTestClock = clock;
    (globalThis as any).__moltenTestProbe = { ticks: {}, hooks: [], busyMs: 0 } satisfies Probe;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    for (const runtime of host.runtimes.values()) {
        host.disposeRuntime(runtime);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("mod activation follows the tab view (FR-PERF-014)", () => {
    it("loads no mod code in a view that does not show, and loads it when the view shows", async () => {
        const { env, importModule } = makeEnv({ alpha: tickingMod("alpha", 1000) }, { ids: ["alpha"] });
        host.showing = false;
        await host.start(env);
        expect(importModule).not.toHaveBeenCalled();
        expect(modState(host, "alpha")).toMatchObject({ state: "pending", commands: [] });

        host.setShowing(true);
        await host.whenLoaded();
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(modState(host, "alpha")).toMatchObject({ state: "active", commands: ["alpha"] });
    });

    it("starts a mod enabled while the view was hidden once the view shows (FR-PERF-014-AC4)", async () => {
        const enabled = { ids: ["alpha"] };
        const { env } = makeEnv({ alpha: commandMod("alpha"), beta: commandMod("beta") }, enabled);
        await host.start(env);
        host.setShowing(false);

        enabled.ids = ["alpha", "beta"];
        await host.reload(["beta"]);
        expect(modState(host, "beta").state).toBe("disabled");

        host.setShowing(true);
        await host.whenLoaded();
        expect(modState(host, "beta")).toMatchObject({ state: "active", commands: ["beta"] });
        expect(await host.runCommand({ command: "beta" })).toMatchObject({ found: true, output: "mine" });
    });

    it("loads the mods on demand when a command reaches a view that does not show", async () => {
        const { env, importModule } = makeEnv({ alpha: commandMod("alpha") }, { ids: ["alpha"] });
        host.showing = false;
        await host.start(env);
        expect(importModule).not.toHaveBeenCalled();

        expect(await host.runCommand({ command: "alpha" })).toMatchObject({ found: true, output: "mine" });
        expect(modState(host, "alpha").state).toBe("active");
    });

    it("holds a mod's timers while the view is hidden and resumes them when it shows", async () => {
        vi.useFakeTimers();
        const { env } = makeEnv({ alpha: tickingMod("alpha", 1000) }, { ids: ["alpha"] });
        await host.start(env);
        advance(3000);
        expect(probe().ticks.alpha).toBe(3);
        expect(modState(host, "alpha").usage.timers).toBe(1);

        host.setShowing(false);
        advance(60000);
        expect(probe().ticks.alpha).toBe(3);
        expect(probe().hooks).toEqual(["alpha:suspend"]);

        host.setShowing(true);
        advance(100);
        expect(probe().ticks.alpha).toBe(4);
        expect(probe().hooks).toEqual(["alpha:suspend", "alpha:resume"]);
    });

    it("keeps the timers of a mod that declares the background capability", async () => {
        vi.useFakeTimers();
        const { env } = makeEnv({ bg: { ...tickingMod("bg", 1000), capabilities: ["background"] } }, { ids: ["bg"] });
        await host.start(env);
        host.setShowing(false);
        advance(5000);
        expect(probe().ticks.bg).toBe(5);
        expect(probe().hooks).toEqual([]);
        expect(modState(host, "bg").background).toBe(true);
    });

    it("starts the timers of a mod loaded on demand in a hidden view held", async () => {
        vi.useFakeTimers();
        const { env } = makeEnv({ alpha: tickingMod("alpha", 1000) }, { ids: ["alpha"] });
        host.showing = false;
        await host.start(env);
        await host.runCommand({ command: "alpha" });
        advance(5000);
        expect(probe().ticks.alpha).toBeUndefined();
        host.setShowing(true);
        advance(1000);
        expect(probe().ticks.alpha).toBeGreaterThan(0);
    });

    it("stops a mod's timers when the mod is disabled", async () => {
        vi.useFakeTimers();
        const enabled = { ids: ["alpha"] };
        const { env } = makeEnv({ alpha: tickingMod("alpha", 1000) }, enabled);
        await host.start(env);
        advance(2000);
        enabled.ids = [];
        await host.reload(["alpha"]);
        advance(5000);
        expect(probe().ticks.alpha).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("mod budget (FR-PERF-014-AC2)", () => {
    it("reports a mod running a busy timer over budget within a minute, with its numbers", async () => {
        vi.useFakeTimers();
        const { env } = makeEnv(
            { calm: tickingMod("calm", 5000), heavy: tickingMod("heavy", 1000) },
            { ids: ["calm", "heavy"] }
        );
        await host.start(env);
        // Only heavy is busy: 100 ms of each second, 10 %.
        const realHeavy = probe();
        let elapsed = 0;
        let reportedAt: number = null;
        while (elapsed < 60000 && reportedAt == null) {
            realHeavy.busyMs = 0;
            advance(900);
            realHeavy.busyMs = 100;
            advance(100);
            elapsed += 1000;
            if (elapsed % MoltenBudgetCheckMs === 0) {
                host.checkBudgets();
                if (modState(host, "heavy").usage?.over) {
                    reportedAt = elapsed;
                }
            }
        }
        expect(reportedAt).not.toBeNull();
        expect(reportedAt).toBeLessThanOrEqual(60000);
        const heavy = modState(host, "heavy").usage;
        expect(heavy.cpupct).toBeGreaterThan(2);
        expect(heavy.timers).toBe(1);
        expect(heavy.reason).toMatch(/% CPU while idle over the last 30 s \(budget 2 %\)/);
        const notes = globalStore.get(host.notificationsAtom).filter((n) => n.kind === "warning");
        expect(notes).toHaveLength(1);
        expect(notes[0].title).toBe('Mod "heavy" is over its budget');
        expect(notes[0].message).toContain("molten mod disable heavy");

        host.checkBudgets();
        expect(globalStore.get(host.notificationsAtom).filter((n) => n.kind === "warning")).toHaveLength(1);
    });

    it("counts the time of activate and of the commands, and lists the usage for molten", async () => {
        const { env } = makeEnv(
            {
                slow: {
                    source: `export function activate(api) {
    globalThis.__moltenTestClock.t += 40;
    api.commands.register("slow", () => { globalThis.__moltenTestClock.t += 15; return "done"; });
}`,
                },
            },
            { ids: ["slow"] }
        );
        await host.start(env);
        expect(modState(host, "slow").usage).toMatchObject({ activatems: 40, scriptms: 40, timers: 0, over: false });
        await host.runCommand({ command: "slow" });
        const listed = host.listMods().mods.find((m) => m.id === "slow");
        expect(listed.usage).toMatchObject({ activatems: 40, scriptms: 55, cpupct: 0, over: false });
    });
});

describe("duplicate command names (FR-PERF-014-AC3)", () => {
    it("keeps the command of the built-in mod and names both mods in the error", async () => {
        const { env } = makeEnv({ copy: commandMod("copy") }, { ids: ["copy"] }, { "copy-box": commandMod("copy") });
        await host.start(env);
        expect(host.commands.get("copy").modId).toBe("copy-box");
        expect(modState(host, "copy")).toMatchObject({
            state: "failed",
            error: 'activate: command "copy" is already registered by mod "copy-box"; mod "copy" cannot register it',
        });
        const errors = globalStore.get(host.notificationsAtom).filter((n) => n.kind === "error");
        expect(errors.map((n) => n.title)).toEqual(['Mods "copy-box" and "copy" both register "copy"']);
    });

    it("keeps the first mod's command when the second is enabled later", async () => {
        const enabled = { ids: ["zeta"] };
        const { env } = makeEnv({ alpha: commandMod("same"), zeta: commandMod("same") }, enabled);
        await host.start(env);
        enabled.ids = ["alpha", "zeta"];
        await host.reload(["alpha"]);
        expect(host.commands.get("same").modId).toBe("zeta");
        expect(modState(host, "alpha").error).toContain('already registered by mod "zeta"; mod "alpha" cannot');
    });

    it("still reports the conflict when the mod catches the refusal", async () => {
        const { env } = makeEnv({ a: commandMod("x"), b: commandMod("x", true) }, { ids: ["a", "b"] });
        await host.start(env);
        expect(modState(host, "b")).toMatchObject({
            state: "active",
            error: 'command "x" is already registered by mod "a"; mod "b" cannot register it',
        });
        const errors = globalStore.get(host.notificationsAtom).filter((n) => n.kind === "error");
        expect(errors.map((n) => n.title)).toEqual(['Mods "a" and "b" both register "x"']);
    });
});
