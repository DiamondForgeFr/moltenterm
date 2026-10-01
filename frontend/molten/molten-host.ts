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
    MoltenCommandHandler,
    MoltenDisposer,
    MoltenNotificationKind,
    MoltenNotificationOptions,
} from "./molten-api";
import { MoltenManifestFileName, MoltenSupportedApiVersions, parseMoltenManifest } from "./molten-manifest";

export const MoltenActivateTimeoutMs = 10000;
export const MoltenNotificationTimeoutMs = 8000;

export type MoltenDirEntry = { name: string; isDir: boolean };

export type MoltenHostEnv = {
    modsDir: string;
    // Returns [] when the directory does not exist.
    listDir(path: string): Promise<MoltenDirEntry[]>;
    // Returns null when the file does not exist.
    readTextFile(path: string): Promise<string>;
    importModule(source: string, sourceName: string): Promise<any>;
    writeClipboard(text: string): Promise<void>;
};

export type MoltenModState = "loading" | "active" | "failed" | "refused";

export type MoltenModStatus = {
    id: string;
    name?: string;
    version?: string;
    path: string;
    state: MoltenModState;
    error?: string;
    commands: string[];
};

export type MoltenModList = {
    apiversions: number[];
    safemode: boolean;
    modsdir: string;
    mods: MoltenModStatus[];
};

export type MoltenNotificationEntry = {
    id: number;
    title: string;
    message?: string;
    kind: MoltenNotificationKind;
    modId?: string;
};

export type MoltenCommandEntry = {
    modId: string;
    name: string;
    description: string;
    handler: MoltenCommandHandler;
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

    env: MoltenHostEnv = null;
    started = false;
    safeMode = false;
    runtimes = new Map<string, ModRuntime>();
    commands = new Map<string, MoltenCommandEntry>();
    nextNotificationId = 1;

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
        let entries: MoltenDirEntry[];
        try {
            entries = await env.listDir(env.modsDir);
        } catch (e) {
            this.notify({ title: "Mods could not be read", message: errorMessage(e), kind: "error" });
            return;
        }
        const folders = entries
            .filter((entry) => entry.isDir && !entry.name.startsWith("."))
            .map((entry) => entry.name)
            .sort();
        for (const folder of folders) {
            await this.loadMod(folder);
        }
    }

    listMods(): MoltenModList {
        return {
            apiversions: [...MoltenSupportedApiVersions],
            safemode: this.safeMode,
            modsdir: this.env?.modsDir ?? "",
            mods: this.snapshot(),
        };
    }

    async loadMod(folder: string): Promise<void> {
        const dir = joinPath(this.env.modsDir, folder);
        const runtime: ModRuntime = {
            status: { id: folder, path: dir, state: "loading", commands: [] },
            disposers: [],
            stopped: false,
        };
        this.runtimes.set(folder, runtime);
        this.publish();
        try {
            await this.activateMod(runtime, folder, dir);
        } catch (e) {
            this.stopRuntime(runtime, "failed", errorMessage(e));
        }
    }

    async activateMod(runtime: ModRuntime, folder: string, dir: string): Promise<void> {
        const manifestText = await this.env.readTextFile(joinPath(dir, MoltenManifestFileName));
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
        const source = await this.env.readTextFile(joinPath(dir, manifest.main));
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

    // Stops a mod: undoes its registrations in reverse order, records why and tells the user. One failing disposer
    // must not keep the others from running.
    stopRuntime(runtime: ModRuntime, state: MoltenModState, error: string): void {
        if (runtime.stopped) {
            return;
        }
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
