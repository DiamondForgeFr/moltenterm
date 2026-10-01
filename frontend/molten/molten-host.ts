// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The mod host (FR-MORPH-001, DS-MORPH-002). Each tab renderer runs its own host: it reads `<config>/mods/`, loads
// every mod through MoltenApi and keeps the workspace running when a mod fails. It touches the app only through
// MoltenHostEnv, so tests can drive it without Electron or wavesrv.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import {
    makeMoltenApi,
    MoltenApiBackend,
    MoltenBoxAction,
    MoltenBoxOptions,
    MoltenCommandHandler,
    MoltenDisposer,
    MoltenNotificationKind,
    MoltenNotificationOptions,
} from "./molten-api";
import { MoltenManifestFileName, MoltenSupportedApiVersions, parseMoltenManifest } from "./molten-manifest";

export const MoltenActivateTimeoutMs = 10000;
export const MoltenNotificationTimeoutMs = 8000;

export type MoltenDirEntry = { name: string; isDir: boolean };

// A mod shipped inside Moltenterm (frontend/molten/builtin/). It is part of the app, so it needs no trust prompt and
// is enabled unless `mods.json` lists it under "disabled".
export type MoltenBuiltinMod = {
    id: string;
    // File name → content, at least mod.json and the file its "main" names.
    files: Record<string, string>;
};

export type MoltenHostEnv = {
    modsDir: string;
    // `<config>/molten/mods.json`, written by `molten mod enable|disable` (cmd/wsh/cmd/wshcmd-molten-mods.go).
    stateFile: string;
    // `<data>/molten/trust.json`, written by `molten` once the user trusted a mod (FR-MORPH-004).
    trustFile: string;
    // Returns [] when the directory does not exist.
    listDir(path: string): Promise<MoltenDirEntry[]>;
    // Returns null when the file does not exist.
    readTextFile(path: string): Promise<string>;
    importModule(source: string, sourceName: string): Promise<any>;
    writeClipboard(text: string): Promise<void>;
    builtins?: MoltenBuiltinMod[];
};

export type MoltenModState = "disabled" | "untrusted" | "loading" | "active" | "failed" | "refused";

export type MoltenModStatus = {
    id: string;
    name?: string;
    version?: string;
    path: string;
    state: MoltenModState;
    error?: string;
    commands: string[];
    builtin?: boolean;
};

export type MoltenCommandInfo = {
    name: string;
    modid: string;
    description: string;
};

export type MoltenModList = {
    apiversions: number[];
    safemode: boolean;
    modsdir: string;
    mods: MoltenModStatus[];
    commands: MoltenCommandInfo[];
};

export type MoltenRunRequest = {
    command: string;
    args?: string[];
    stdin?: string;
    blockid?: string;
};

export type MoltenRunResult = {
    found: boolean;
    output?: string;
    exitcode?: number;
    error?: string;
    commands?: string[];
};

export type MoltenNotificationEntry = {
    id: number;
    title: string;
    message?: string;
    kind: MoltenNotificationKind;
    modId?: string;
};

export type MoltenBoxEntry = {
    id: number;
    modId: string;
    blockId?: string;
    title?: string;
    text: string;
    monospace: boolean;
    actions: MoltenBoxAction[];
};

export type MoltenCommandEntry = {
    modId: string;
    name: string;
    description: string;
    handler: MoltenCommandHandler;
};

type ModFileReader = (name: string) => Promise<string>;

type ModState = {
    enabled: Set<string>;
    disabled: Set<string>;
};

type ModRuntime = {
    status: MoltenModStatus;
    disposers: MoltenDisposer[];
    stopped: boolean;
};

function errorMessage(e: unknown): string {
    if (e instanceof Error) {
        return e.message;
    }
    return String(e);
}

function joinPath(dir: string, name: string): string {
    return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class MoltenHost {
    private static instance: MoltenHost = null;

    modsAtom = atom<MoltenModStatus[]>([]) as PrimitiveAtom<MoltenModStatus[]>;
    notificationsAtom = atom<MoltenNotificationEntry[]>([]) as PrimitiveAtom<MoltenNotificationEntry[]>;
    boxesAtom = atom<MoltenBoxEntry[]>([]) as PrimitiveAtom<MoltenBoxEntry[]>;

    env: MoltenHostEnv = null;
    started = false;
    safeMode = false;
    runtimes = new Map<string, ModRuntime>();
    commands = new Map<string, MoltenCommandEntry>();
    nextNotificationId = 1;
    nextBoxId = 1;
    // Starts and reloads run one at a time: an enable arriving while the mods load must see the finished state.
    queue: Promise<void> = Promise.resolve();

    private constructor() {}

    static getInstance(): MoltenHost {
        if (!MoltenHost.instance) {
            MoltenHost.instance = new MoltenHost();
        }
        return MoltenHost.instance;
    }

    static resetInstance(): void {
        MoltenHost.instance = null;
    }

    async start(env: MoltenHostEnv, opts?: { safeMode?: boolean }): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.env = env;
        this.safeMode = !!opts?.safeMode;
        if (this.safeMode) {
            return;
        }
        await this.enqueue(() => this.syncMods(null));
    }

    // Applies a change announced by `molten` (enable, disable, remove), or by the watcher of #19. With ids, only those
    // mods are stopped and loaded again; with null, every mod is.
    reload(ids: string[]): Promise<void> {
        if (!this.started || this.safeMode) {
            return Promise.resolve();
        }
        return this.enqueue(() => this.syncMods(ids));
    }

    enqueue(fn: () => Promise<void>): Promise<void> {
        const next = this.queue.then(fn, fn);
        this.queue = next.catch(() => {});
        return next;
    }

    async syncMods(ids: string[]): Promise<void> {
        let folders: string[];
        let state: ModState;
        let trusted: Set<string>;
        try {
            const entries = await this.env.listDir(this.env.modsDir);
            folders = entries
                .filter((entry) => entry.isDir && !entry.name.startsWith("."))
                .map((entry) => entry.name)
                .sort();
            state = await this.readState();
            trusted = await this.readTrusted();
        } catch (e) {
            this.notify({ title: "Mods could not be read", message: errorMessage(e), kind: "error" });
            return;
        }
        const builtins = this.env.builtins ?? [];
        const targets = ids ?? [...new Set([...this.runtimes.keys(), ...folders, ...builtins.map((b) => b.id)])].sort();
        for (const id of targets) {
            this.unloadMod(id);
            const builtin = builtins.find((b) => b.id === id);
            if (builtin != null) {
                await this.syncBuiltin(builtin, state, folders.includes(id));
                continue;
            }
            if (!folders.includes(id)) {
                continue;
            }
            const enabled = state.enabled;
            // No code of a mod is read before the user trusted it, even when mods.json enables it by hand.
            if (!enabled.has(id) || !trusted.has(id)) {
                this.runtimes.set(id, {
                    status: {
                        id,
                        path: joinPath(this.env.modsDir, id),
                        state: enabled.has(id) ? "untrusted" : "disabled",
                        commands: [],
                    },
                    disposers: [],
                    stopped: true,
                });
                continue;
            }
            const dir = joinPath(this.env.modsDir, id);
            await this.loadMod(id, dir, (name) => this.env.readTextFile(joinPath(dir, name)));
        }
        this.sortRuntimes();
        this.publish();
    }

    async syncBuiltin(builtin: MoltenBuiltinMod, state: ModState, shadowed: boolean): Promise<void> {
        const path = `builtin:${builtin.id}`;
        if (state.disabled.has(builtin.id)) {
            this.runtimes.set(builtin.id, {
                status: { id: builtin.id, path, state: "disabled", commands: [], builtin: true },
                disposers: [],
                stopped: true,
            });
            return;
        }
        await this.loadMod(builtin.id, path, async (name) => builtin.files[name] ?? null, true);
        if (shadowed) {
            this.notify({
                title: `Mod folder "${builtin.id}" ignored`,
                message: `"${builtin.id}" is a built-in mod; rename the folder in ${this.env.modsDir} to load it.`,
                kind: "warning",
            });
        }
    }

    async readJsonFile(path: string): Promise<any> {
        const text = await this.env.readTextFile(path);
        if (text == null || text.trim() === "") {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`${path} is not valid JSON: ${errorMessage(e)}`);
        }
    }

    async readState(): Promise<ModState> {
        const state = await this.readJsonFile(this.env.stateFile);
        const ids = (list: unknown): Set<string> =>
            new Set(Array.isArray(list) ? list.filter((id: unknown) => typeof id === "string") : []);
        return { enabled: ids(state?.enabled), disabled: ids(state?.disabled) };
    }

    async readTrusted(): Promise<Set<string>> {
        const trust = await this.readJsonFile(this.env.trustFile);
        const map = trust?.trusted;
        if (map == null || typeof map !== "object" || Array.isArray(map)) {
            return new Set();
        }
        return new Set(Object.keys(map));
    }

    // Stops a mod without reporting it as failed: the user asked for it.
    unloadMod(id: string): void {
        const runtime = this.runtimes.get(id);
        if (runtime == null) {
            return;
        }
        this.disposeRuntime(runtime);
        this.runtimes.delete(id);
        this.publish();
    }

    sortRuntimes(): void {
        const sorted = [...this.runtimes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        this.runtimes = new Map(sorted);
    }

    async runCommand(req: MoltenRunRequest): Promise<MoltenRunResult> {
        const entry = this.commands.get(req?.command);
        if (entry == null) {
            return { found: false, commands: [...this.commands.keys()].sort() };
        }
        try {
            const result = await entry.handler({
                args: req.args ?? [],
                stdin: req.stdin,
                blockId: req.blockid,
            });
            if (result == null) {
                return { found: true, output: "", exitcode: 0 };
            }
            if (typeof result === "string") {
                return { found: true, output: result, exitcode: 0 };
            }
            const obj = result as { output?: string; exitCode?: number };
            const exitcode = Number.isInteger(obj.exitCode) ? obj.exitCode : 0;
            return { found: true, output: obj.output == null ? "" : String(obj.output), exitcode };
        } catch (e) {
            return { found: true, output: "", exitcode: 1, error: errorMessage(e) };
        }
    }

    listMods(): MoltenModList {
        return {
            apiversions: [...MoltenSupportedApiVersions],
            safemode: this.safeMode,
            modsdir: this.env?.modsDir ?? "",
            mods: this.snapshot(),
            commands: [...this.commands.values()]
                .map((c) => ({ name: c.name, modid: c.modId, description: c.description }))
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        };
    }

    async loadMod(id: string, path: string, read: ModFileReader, builtin = false): Promise<void> {
        const runtime: ModRuntime = {
            status: { id, path, state: "loading", commands: [], ...(builtin ? { builtin } : {}) },
            disposers: [],
            stopped: false,
        };
        this.runtimes.set(id, runtime);
        this.publish();
        try {
            await this.activateMod(runtime, id, read);
        } catch (e) {
            this.stopRuntime(runtime, "failed", errorMessage(e));
        }
    }

    async activateMod(runtime: ModRuntime, folder: string, read: ModFileReader): Promise<void> {
        const manifestText = await read(MoltenManifestFileName);
        if (manifestText == null) {
            this.stopRuntime(runtime, "failed", `${MoltenManifestFileName} not found`);
            return;
        }
        const parsed = parseMoltenManifest(folder, manifestText);
        if (parsed.ok === false) {
            this.stopRuntime(runtime, parsed.refused ? "refused" : "failed", parsed.error);
            return;
        }
        const manifest = parsed.manifest;
        runtime.status.name = manifest.name;
        runtime.status.version = manifest.version;
        const source = await read(manifest.main);
        if (source == null) {
            this.stopRuntime(runtime, "failed", `main file "${manifest.main}" not found`);
            return;
        }
        let mod: any;
        try {
            mod = await this.env.importModule(source, `${manifest.id}/${manifest.main}`);
        } catch (e) {
            this.stopRuntime(runtime, "failed", `loading ${manifest.main}: ${errorMessage(e)}`);
            return;
        }
        if (typeof mod?.activate !== "function") {
            this.stopRuntime(runtime, "failed", `${manifest.main} does not export an activate(api) function`);
            return;
        }
        const api = makeMoltenApi(manifest, this.makeBackend(runtime));
        try {
            await withTimeout(
                Promise.resolve().then(() => mod.activate(api)),
                MoltenActivateTimeoutMs,
                `activate did not finish within ${MoltenActivateTimeoutMs / 1000} s`
            );
        } catch (e) {
            this.stopRuntime(runtime, "failed", `activate: ${errorMessage(e)}`);
            return;
        }
        if (runtime.stopped) {
            return;
        }
        runtime.status.state = "active";
        this.publish();
    }

    makeBackend(runtime: ModRuntime): MoltenApiBackend {
        const modId = runtime.status.id;
        return {
            isStopped: () => runtime.stopped,
            track: (dispose: MoltenDisposer) => {
                let disposed = false;
                const tracked = () => {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    runtime.disposers = runtime.disposers.filter((d) => d !== tracked);
                    dispose();
                };
                runtime.disposers.push(tracked);
                return tracked;
            },
            fail: (err: unknown) => this.stopRuntime(runtime, "failed", errorMessage(err)),
            registerCommand: (name, description, handler) => this.registerCommand(runtime, name, description, handler),
            showNotification: (opts: MoltenNotificationOptions) => this.notify(opts, modId),
            showBox: (opts: MoltenBoxOptions) => this.showBox(opts, modId),
            writeClipboard: (text: string) => this.env.writeClipboard(text),
        };
    }

    registerCommand(
        runtime: ModRuntime,
        name: string,
        description: string,
        handler: MoltenCommandHandler
    ): MoltenDisposer {
        const modId = runtime.status.id;
        const existing = this.commands.get(name);
        if (existing != null) {
            throw new Error(`command "${name}" is already registered by mod "${existing.modId}"`);
        }
        const entry: MoltenCommandEntry = { modId, name, description, handler };
        this.commands.set(name, entry);
        runtime.status.commands = [...runtime.status.commands, name];
        this.publish();
        return () => {
            if (this.commands.get(name) === entry) {
                this.commands.delete(name);
            }
            runtime.status.commands = runtime.status.commands.filter((c) => c !== name);
            this.publish();
        };
    }

    // Stops a failed or refused mod: undoes its registrations, records why and tells the user.
    stopRuntime(runtime: ModRuntime, state: MoltenModState, error: string): void {
        if (runtime.stopped) {
            return;
        }
        this.disposeRuntime(runtime);
        runtime.status.state = state;
        runtime.status.error = error;
        runtime.status.commands = [];
        this.publish();
        console.error(`[molten:${runtime.status.id}] ${state}: ${error}`);
        this.notify({
            title: `Mod "${runtime.status.id}" ${state === "refused" ? "was refused" : "stopped"}`,
            message: error,
            kind: state === "refused" ? "warning" : "error",
        });
    }

    // Undoes a mod's registrations in reverse order. One failing disposer must not keep the others from running.
    disposeRuntime(runtime: ModRuntime): void {
        runtime.stopped = true;
        const disposers = [...runtime.disposers].reverse();
        for (const dispose of disposers) {
            try {
                dispose();
            } catch (e) {
                console.error(`[molten:${runtime.status.id}] disposer failed`, e);
            }
        }
        runtime.disposers = [];
    }

    notify(opts: MoltenNotificationOptions, modId?: string): MoltenDisposer {
        const id = this.nextNotificationId++;
        const entry: MoltenNotificationEntry = {
            id,
            title: opts.title,
            message: opts.message,
            kind: opts.kind ?? "info",
            modId,
        };
        globalStore.set(this.notificationsAtom, [...globalStore.get(this.notificationsAtom), entry]);
        const dismiss = () => this.dismissNotification(id);
        // Errors stay until the user closes them: they explain why a mod is gone.
        if (entry.kind !== "error") {
            setTimeout(dismiss, MoltenNotificationTimeoutMs);
        }
        return dismiss;
    }

    showBox(opts: MoltenBoxOptions, modId: string): MoltenDisposer {
        const id = this.nextBoxId++;
        const entry: MoltenBoxEntry = {
            id,
            modId,
            blockId: opts.blockId || undefined,
            title: opts.title,
            text: opts.text,
            monospace: !!opts.monospace,
            actions: opts.actions ?? [],
        };
        globalStore.set(this.boxesAtom, [...globalStore.get(this.boxesAtom), entry]);
        return () => this.dismissBox(id);
    }

    dismissBox(id: number): void {
        const current = globalStore.get(this.boxesAtom);
        if (!current.some((b) => b.id === id)) {
            return;
        }
        globalStore.set(
            this.boxesAtom,
            current.filter((b) => b.id !== id)
        );
    }

    dismissNotification(id: number): void {
        const current = globalStore.get(this.notificationsAtom);
        if (!current.some((n) => n.id === id)) {
            return;
        }
        globalStore.set(
            this.notificationsAtom,
            current.filter((n) => n.id !== id)
        );
    }

    snapshot(): MoltenModStatus[] {
        return [...this.runtimes.values()].map((r) => ({ ...r.status, commands: [...r.status.commands] }));
    }

    publish(): void {
        globalStore.set(this.modsAtom, this.snapshot());
    }
}
