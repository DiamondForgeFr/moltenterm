// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The mod host (FR-MORPH-001, DS-MORPH-002). Each tab renderer runs its own host: it reads `<config>/mods/`, loads
// every mod through MoltenApi and keeps the workspace running when a mod fails. It touches the app only through
// MoltenHostEnv, so tests can drive it without Electron or wavesrv.
//
// A mod's cost is paid once per tab view that runs it (FR-PERF-014, DS-PERF-012): a view loads mod code only once it
// shows, or when a molten request needs it; the hot spare never starts the host; a hidden view holds its mods' timers.
// Each mod is measured against its budget (molten-budget.ts).

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { t } from "../moltenterm-shell/i18n/i18n";
import { shippedDictionary } from "../moltenterm-shell/i18n/i18n-core";
import { checkLanguagePack, formatPackProblems } from "../moltenterm-shell/i18n/language-pack";
import type { LanguagePackInput } from "../moltenterm-shell/i18n/language-packs";
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
import { MoltenModMeter, MoltenModUsage, sameUsage } from "./molten-budget";
import {
    isDataOnlyMod,
    MoltenManifestFileName,
    MoltenModManifest,
    MoltenSupportedApiVersions,
    parseMoltenManifest,
} from "./molten-manifest";
import { declaresTimerName, MoltenModTimers, MoltenTimerApi, MoltenTimerClock, timerPrologue } from "./molten-timers";

export const MoltenActivateTimeoutMs = 10000;
export const MoltenNotificationTimeoutMs = 8000;
// A mod that declares it keeps working while its tab view is hidden (FR-PERF-014): its timers are never held.
export const MoltenBackgroundCapability = "background";
// Where a mod's module finds its timers while it is imported (molten-timers.ts).
export const MoltenTimerRegistryName = "__moltenModTimers";

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
    // The interface language and its changes (FR-I18N-001, DS-I18N-005); English and no change without them.
    getLocale?: () => string;
    onLocaleChange?: (handler: (locale: string) => void) => () => void;
    builtins?: MoltenBuiltinMod[];
    // Receives the languages of the active language packs after every sync (FR-I18N-002, language-packs.ts).
    applyLanguagePacks?: (packs: LanguagePackInput[]) => void;
    // The clock of the budget and of the mods' timers; performance.now and the window's timers by default.
    clock?: MoltenTimerClock;
    // The renderer's JS heap in MB, or null when it does not tell (best-effort memory of a mod's activation).
    heapUsedMB?: () => number;
};

// pending: enabled, its code waits for the tab view to show (FR-PERF-014).
export type MoltenModState =
    | "disabled"
    | "untrusted"
    | "safemode"
    | "pending"
    | "loading"
    | "active"
    | "failed"
    | "refused";

export type MoltenModStatus = {
    id: string;
    name?: string;
    version?: string;
    path: string;
    state: MoltenModState;
    error?: string;
    commands: string[];
    builtin?: boolean;
    // Keeps its timers running while the tab view is hidden (it declares the "background" capability).
    background?: boolean;
    usage?: MoltenModUsage;
    // A data-only mod: it brings data (languages) and runs no code, so it needs no trust (FR-I18N-002).
    dataonly?: boolean;
    // The language codes a language pack gives.
    languages?: string[];
    // What loading ignored, such as a pack key English does not know.
    warnings?: string[];
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
    // When each mod was last enabled (`enabledat` in mods.json, ms since epoch).
    enabledAt: Map<string, number>;
};

function emptyState(): ModState {
    return { enabled: new Set(), disabled: new Set(), enabledAt: new Map() };
}

type ModRuntime = {
    status: MoltenModStatus;
    disposers: MoltenDisposer[];
    stopped: boolean;
    meter?: MoltenModMeter;
    timers?: MoltenModTimers;
    // The mod's module, for its optional suspend() and resume() exports.
    module?: any;
    overNotified?: boolean;
    // Set when the mod tried a command name another mod holds, even if its activate caught the error.
    conflict?: MoltenCommandConflictError;
    enabledAt?: number;
    // The checked languages of an active language pack.
    languages?: LanguagePackInput[];
};

// A command name another mod holds: the error names both mods (FR-PERF-014-AC3).
export class MoltenCommandConflictError extends Error {
    command: string;
    holder: string;
    claimant: string;

    constructor(command: string, holder: string, claimant: string) {
        super(`command "${command}" is already registered by mod "${holder}"; mod "${claimant}" cannot register it`);
        this.command = command;
        this.holder = holder;
        this.claimant = claimant;
    }
}

let timerTokenSeq = 1;

function timerRegistry(): Map<string, MoltenTimerApi> {
    const g = globalThis as any;
    g[MoltenTimerRegistryName] ??= new Map<string, MoltenTimerApi>();
    return g[MoltenTimerRegistryName];
}

const DefaultClock: MoltenTimerClock = {
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

function conflictTitle(e: MoltenCommandConflictError): string {
    return t("molten.notify.conflict", { holder: e.holder, claimant: e.claimant, command: e.command });
}

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
    // Called for every notification the host shows; the shell records mod failures in its notification center.
    notificationListener: (entry: MoltenNotificationEntry) => void = null;
    nextBoxId = 1;
    // Starts and reloads run one at a time: an enable arriving while the mods load must see the finished state.
    queue: Promise<void> = Promise.resolve();
    // A save seen by the watcher of #19 and announced by molten, or a quick series of saves, asks for the same reload
    // several times: requests made while one is waiting to run are merged into it.
    pendingReloadIds = new Set<string>();
    pendingReloadAll = false;
    scheduledReload: Promise<void> = null;
    // Whether this tab view shows (TabActivity, FR-PERF-014). A view that does not show loads no mod code: the loads
    // wait in the pending requests above until it shows, or until a molten request needs the mods. Running mods keep
    // their state while it is hidden, but their timers are held.
    showing = true;

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
            await this.enqueue(() => this.listForSafeMode());
            return;
        }
        this.pendingReloadAll = true;
        if (!this.showing) {
            await this.enqueue(() => this.listPending());
            return;
        }
        await this.schedulePending();
    }

    // Applies a change announced by `molten` (enable, disable, remove), or by the watcher of #19. With ids, only those
    // mods are stopped and loaded again; with null, every mod is. A view that does not show applies it when it shows.
    reload(ids: string[]): Promise<void> {
        if (!this.started || this.safeMode) {
            return Promise.resolve();
        }
        if (ids == null) {
            this.pendingReloadAll = true;
        } else {
            ids.forEach((id) => this.pendingReloadIds.add(id));
        }
        if (!this.showing) {
            return Promise.resolve();
        }
        return this.schedulePending();
    }

    hasPending(): boolean {
        return this.pendingReloadAll || this.pendingReloadIds.size > 0;
    }

    // Called by molten-start whenever the view's activity changes between showing and not showing.
    setShowing(showing: boolean): void {
        if (showing === this.showing) {
            return;
        }
        this.showing = showing;
        for (const runtime of this.runtimes.values()) {
            if (runtime.stopped || runtime.status.background) {
                continue;
            }
            if (showing) {
                this.resumeRuntime(runtime);
            } else {
                this.suspendRuntime(runtime);
            }
        }
        if (showing && this.started && !this.safeMode && this.hasPending()) {
            this.schedulePending().catch(() => {});
        }
    }

    // Waits until the mods this view should run are loaded, loading the pending ones now even if the view does not
    // show: a molten command from a terminal of a hidden tab (an agent at work) must find them.
    async whenLoaded(): Promise<void> {
        if (this.started && !this.safeMode && this.hasPending()) {
            await this.schedulePending();
            return;
        }
        await this.queue;
    }

    schedulePending(): Promise<void> {
        if (this.scheduledReload != null) {
            return this.scheduledReload;
        }
        this.scheduledReload = this.enqueue(() => {
            const all = this.pendingReloadAll;
            const pending = [...this.pendingReloadIds].sort();
            this.pendingReloadIds = new Set();
            this.pendingReloadAll = false;
            this.scheduledReload = null;
            return this.syncMods(all ? null : pending);
        });
        return this.scheduledReload;
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
            this.notify({ title: t("molten.notify.unreadable"), message: errorMessage(e), kind: "error" });
            this.applyLanguages();
            return;
        }
        const builtins = this.env.builtins ?? [];
        const builtinIds = new Set(builtins.map((b) => b.id));
        // Built-in mods load first, then the others in id order: when two mods register the same command, every tab
        // view gives it to the same one (FR-PERF-014-AC3). A mod loaded later never takes it from a running one.
        const targets = (ids ?? [...new Set([...this.runtimes.keys(), ...folders, ...builtinIds])]).sort((a, b) => {
            const rank = Number(builtinIds.has(b)) - Number(builtinIds.has(a));
            return rank !== 0 ? rank : a < b ? -1 : a > b ? 1 : 0;
        });
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
            const dir = joinPath(this.env.modsDir, id);
            // No code of a mod is read before the user trusted it, even when mods.json enables it by hand. A
            // data-only mod has no code: its manifest is read to know it, and it loads without trust.
            const loadable = enabled.has(id) && (trusted.has(id) || isDataOnlyMod(await this.peekManifest(id, dir)));
            if (!loadable) {
                this.runtimes.set(id, {
                    status: {
                        id,
                        path: dir,
                        state: enabled.has(id) ? "untrusted" : "disabled",
                        commands: [],
                    },
                    disposers: [],
                    stopped: true,
                });
                continue;
            }
            await this.loadMod(id, dir, (name) => this.env.readTextFile(joinPath(dir, name)), false, state);
        }
        this.sortRuntimes();
        this.publish();
        this.applyLanguages();
    }

    // The manifest of a user mod, parsed but nothing else read; a manifest that does not parse gives an empty one.
    async peekManifest(id: string, dir: string): Promise<MoltenModManifest> {
        try {
            const text = await this.env.readTextFile(joinPath(dir, MoltenManifestFileName));
            const parsed = text == null ? null : parseMoltenManifest(id, text);
            return parsed?.ok ? parsed.manifest : ({} as MoltenModManifest);
        } catch {
            return {} as MoltenModManifest;
        }
    }

    // Hands the languages of the active language packs to the dictionaries (language-packs.ts).
    applyLanguages(): void {
        const packs: LanguagePackInput[] = [];
        for (const runtime of this.runtimes.values()) {
            if (runtime.stopped || runtime.status.state !== "active" || runtime.languages == null) {
                continue;
            }
            packs.push(...runtime.languages);
        }
        try {
            this.env?.applyLanguagePacks?.(packs);
        } catch (e) {
            console.error("[molten] language packs could not be applied", e);
        }
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
                title: t("molten.notify.shadowedTitle", { id: builtin.id }),
                message: t("molten.notify.shadowedMessage", { id: builtin.id, dir: this.env.modsDir }),
                kind: "warning",
            });
        }
    }

    // A view that does not show lists its mods without reading their code: the enabled ones are pending. Data-only
    // mods load at once: they cost nothing while idle, and a view must speak a pack's language before it shows.
    async listPending(): Promise<void> {
        let folders: string[] = [];
        let state: ModState = emptyState();
        let trusted = new Set<string>();
        try {
            folders = (await this.env.listDir(this.env.modsDir))
                .filter((entry) => entry.isDir && !entry.name.startsWith("."))
                .map((entry) => entry.name);
            state = await this.readState();
            trusted = await this.readTrusted();
        } catch (e) {
            console.error("[molten] mods could not be listed", e);
        }
        const builtinIds = (this.env.builtins ?? []).map((b) => b.id);
        for (const id of [...new Set([...folders, ...builtinIds])].sort()) {
            if (this.runtimes.has(id)) {
                continue;
            }
            const builtin = builtinIds.includes(id);
            let modState: MoltenModState = "pending";
            if (builtin ? state.disabled.has(id) : !state.enabled.has(id)) {
                modState = "disabled";
            } else if (!builtin) {
                const dir = joinPath(this.env.modsDir, id);
                if (isDataOnlyMod(await this.peekManifest(id, dir))) {
                    await this.loadMod(id, dir, (name) => this.env.readTextFile(joinPath(dir, name)), false, state);
                    continue;
                }
                if (!trusted.has(id)) {
                    modState = "untrusted";
                }
            }
            this.runtimes.set(id, {
                status: {
                    id,
                    path: builtin ? `builtin:${id}` : joinPath(this.env.modsDir, id),
                    state: modState,
                    commands: [],
                    ...(builtin ? { builtin } : {}),
                },
                disposers: [],
                stopped: true,
            });
        }
        this.sortRuntimes();
        this.publish();
        this.applyLanguages();
    }

    // In safe mode no mod code is read, but the mods are still listed, so the user knows which one to disable. No
    // language pack applies either.
    async listForSafeMode(): Promise<void> {
        let folders: string[] = [];
        let state: ModState = emptyState();
        try {
            folders = (await this.env.listDir(this.env.modsDir))
                .filter((entry) => entry.isDir && !entry.name.startsWith("."))
                .map((entry) => entry.name);
            state = await this.readState();
        } catch (e) {
            console.error("[molten] safe mode: mods could not be listed", e);
        }
        const builtinIds = (this.env.builtins ?? []).map((b) => b.id);
        for (const id of [...new Set([...folders, ...builtinIds])].sort()) {
            const builtin = builtinIds.includes(id);
            const off = builtin ? state.disabled.has(id) : !state.enabled.has(id);
            this.runtimes.set(id, {
                status: {
                    id,
                    path: builtin ? `builtin:${id}` : joinPath(this.env.modsDir, id),
                    state: off ? "disabled" : "safemode",
                    commands: [],
                    ...(builtin ? { builtin } : {}),
                },
                disposers: [],
                stopped: true,
            });
        }
        this.publish();
        this.applyLanguages();
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
        const enabledAt = new Map<string, number>();
        const stamps = state?.enabledat;
        if (stamps != null && typeof stamps === "object" && !Array.isArray(stamps)) {
            for (const [id, stamp] of Object.entries(stamps)) {
                const ms = typeof stamp === "string" ? Date.parse(stamp) : NaN;
                if (Number.isFinite(ms)) enabledAt.set(id, ms);
            }
        }
        return { enabled: ids(state?.enabled), disabled: ids(state?.disabled), enabledAt };
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
        await this.whenLoaded();
        const entry = this.commands.get(req?.command);
        if (entry == null) {
            return { found: false, commands: [...this.commands.keys()].sort() };
        }
        const meter = this.runtimes.get(entry.modId)?.meter;
        const call = () => entry.handler({ args: req.args ?? [], stdin: req.stdin, blockId: req.blockid });
        try {
            const result = await (meter != null ? meter.measure(call) : call());
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
        this.checkBudgets();
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

    async loadMod(id: string, path: string, read: ModFileReader, builtin = false, state?: ModState): Promise<void> {
        const runtime: ModRuntime = {
            status: { id, path, state: "loading", commands: [], ...(builtin ? { builtin } : {}) },
            disposers: [],
            stopped: false,
            enabledAt: state?.enabledAt.get(id) ?? 0,
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
        if (isDataOnlyMod(manifest)) {
            await this.activateDataMod(runtime, manifest, read);
            return;
        }
        const source = await read(manifest.main);
        if (source == null) {
            this.stopRuntime(runtime, "failed", `main file "${manifest.main}" not found`);
            return;
        }
        const clock = this.clock();
        const meter = new MoltenModMeter(clock.now);
        runtime.meter = meter;
        runtime.status.background = manifest.capabilities.includes(MoltenBackgroundCapability) || undefined;
        const timers = new MoltenModTimers(
            clock,
            (fn) => this.runForMod(runtime, fn, true),
            (count) => (meter.timers = count)
        );
        runtime.timers = timers;
        runtime.disposers.push(() => timers.dispose());
        if (!this.showing && !runtime.status.background) {
            timers.pause();
        }
        // The mod's timers are shadowed in its module scope (molten-timers.ts), unless it declares one of their names.
        let code = source;
        let token: string = null;
        if (!declaresTimerName(source)) {
            token = `${manifest.id}#${timerTokenSeq++}`;
            timerRegistry().set(token, timers.api());
            code = timerPrologue(MoltenTimerRegistryName, token) + source;
        }
        const heapBefore = this.heapUsedMB();
        let mod: any;
        try {
            mod = await this.env.importModule(code, `${manifest.id}/${manifest.main}`);
        } catch (e) {
            this.stopRuntime(runtime, "failed", `loading ${manifest.main}: ${errorMessage(e)}`);
            return;
        } finally {
            if (token != null) {
                timerRegistry().delete(token);
            }
        }
        if (typeof mod?.activate !== "function") {
            this.stopRuntime(runtime, "failed", `${manifest.main} does not export an activate(api) function`);
            return;
        }
        runtime.module = mod;
        const api = makeMoltenApi(manifest, this.makeBackend(runtime));
        try {
            await withTimeout(
                Promise.resolve().then(() => meter.measure(() => mod.activate(api))),
                MoltenActivateTimeoutMs,
                `activate did not finish within ${MoltenActivateTimeoutMs / 1000} s`
            );
        } catch (e) {
            const title = e instanceof MoltenCommandConflictError ? conflictTitle(e) : null;
            this.stopRuntime(runtime, "failed", `activate: ${errorMessage(e)}`, title);
            return;
        }
        if (runtime.stopped) {
            return;
        }
        meter.activateMs = meter.scriptMs;
        const heapAfter = this.heapUsedMB();
        if (heapBefore != null && heapAfter != null) {
            meter.heapMB = Math.max(0, heapAfter - heapBefore);
        }
        runtime.status.state = "active";
        runtime.status.usage = meter.usage(clock.now());
        if (runtime.conflict != null) {
            // The mod caught the refusal and runs without that command: still tell the user, naming both mods.
            runtime.status.error = runtime.conflict.message;
            this.notify({ title: conflictTitle(runtime.conflict), message: runtime.conflict.message, kind: "error" });
        }
        if (!this.showing && !runtime.status.background) {
            this.callHook(runtime, "suspend");
        }
        this.publish();
    }

    // A data-only mod: its files are read as JSON and checked, nothing is imported. A language pack that breaks a
    // placeholder is refused whole, naming the key, so none of it applies (DS-I18N-010).
    async activateDataMod(runtime: ModRuntime, manifest: MoltenModManifest, read: ModFileReader): Promise<void> {
        runtime.status.dataonly = true;
        const english = shippedDictionary("en");
        const languages: LanguagePackInput[] = [];
        const warnings: string[] = [];
        for (const language of manifest.languages ?? []) {
            const text = await read(language.file);
            if (text == null) {
                this.stopRuntime(runtime, "failed", `language file "${language.file}" not found`);
                return;
            }
            let data: unknown;
            try {
                data = JSON.parse(text);
            } catch (e) {
                this.stopRuntime(runtime, "failed", `${language.file} is not valid JSON: ${errorMessage(e)}`);
                return;
            }
            const check = checkLanguagePack(language.code, data, english);
            if (!check.ok) {
                this.stopRuntime(runtime, "refused", `${language.file}: ${formatPackProblems(check)}`);
                return;
            }
            warnings.push(...check.warnings.map((w) => `${language.file}: ${w.message}`));
            languages.push({
                modId: manifest.id,
                code: language.code,
                name: language.name,
                dict: check.dict,
                enabledAt: runtime.enabledAt ?? 0,
                warnings: check.warnings.map((w) => w.message),
            });
        }
        if (runtime.stopped) {
            return;
        }
        for (const warning of warnings) {
            console.warn(`[molten:${manifest.id}] ${warning}`);
        }
        runtime.languages = languages;
        runtime.status.languages = languages.map((l) => l.code);
        if (warnings.length > 0) {
            runtime.status.warnings = warnings;
        }
        runtime.status.state = "active";
        this.publish();
    }

    clock(): MoltenTimerClock {
        return this.env?.clock ?? DefaultClock;
    }

    heapUsedMB(): number {
        try {
            const mb = this.env?.heapUsedMB?.();
            return typeof mb === "number" && Number.isFinite(mb) ? mb : null;
        } catch {
            return null;
        }
    }

    // Runs a timer callback (or a hook) for a mod, measured. A throw is logged: unlike a command handler, a timer has
    // no caller to report to, and the mod's own window timers behaved the same way before they were shadowed.
    runForMod(runtime: ModRuntime, fn: () => void, idle: boolean): void {
        if (runtime.stopped) {
            return;
        }
        runtime.meter.measure(() => {
            try {
                fn();
            } catch (e) {
                console.error(`[molten:${runtime.status.id}] callback failed`, e);
            }
        }, idle);
    }

    callHook(runtime: ModRuntime, name: "suspend" | "resume"): void {
        const hook = runtime.module?.[name];
        if (typeof hook !== "function") {
            return;
        }
        this.runForMod(runtime, () => hook.call(runtime.module), false);
    }

    suspendRuntime(runtime: ModRuntime): void {
        runtime.timers?.pause();
        if (runtime.status.state === "active") {
            this.callHook(runtime, "suspend");
        }
    }

    resumeRuntime(runtime: ModRuntime): void {
        runtime.timers?.resume();
        if (runtime.status.state === "active") {
            this.callHook(runtime, "resume");
        }
    }

    // Long animation frames whose scripts come from a mod (molten-start.ts): its work outside the host's own calls.
    recordLongFrameScript(modId: string, ms: number, at: number): void {
        const runtime = this.runtimes.get(modId);
        if (runtime == null || runtime.stopped || runtime.meter == null) {
            return;
        }
        runtime.meter.addLongFrameScript(ms, at);
    }

    // Compares every running mod with its budget (FR-PERF-014): its usage goes to the mod list, and a mod newly over
    // budget is reported once until it comes back under.
    checkBudgets(): void {
        const now = this.clock().now();
        let changed = false;
        for (const runtime of this.runtimes.values()) {
            if (runtime.stopped || runtime.meter == null || runtime.status.state !== "active") {
                continue;
            }
            const usage = runtime.meter.usage(now);
            // The list always gets the fresh numbers; the screens re-render only when they moved enough to show.
            changed ||= !sameUsage(usage, runtime.status.usage);
            runtime.status.usage = usage;
            if (!usage.over) {
                runtime.overNotified = false;
                continue;
            }
            if (runtime.overNotified) {
                continue;
            }
            runtime.overNotified = true;
            const id = runtime.status.id;
            console.warn(`[molten:${id}] over budget: ${usage.reason}`);
            this.notify({
                title: t("molten.notify.overBudgetTitle", { id }),
                message: t("molten.notify.overBudgetMessage", { reason: usage.reason, id }),
                kind: "warning",
            });
        }
        if (changed) {
            this.publish();
        }
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
            showBox: (opts: MoltenBoxOptions) =>
                this.showBox(
                    {
                        ...opts,
                        actions: (opts.actions ?? []).map((action) => ({
                            ...action,
                            run: () => (runtime.meter != null ? runtime.meter.measure(action.run) : action.run()),
                        })),
                    },
                    modId
                ),
            writeClipboard: (text: string) => this.env.writeClipboard(text),
            getLocale: () => this.env.getLocale?.() ?? "en",
            onLocaleChange: (handler: (locale: string) => void) => this.env.onLocaleChange?.(handler) ?? (() => {}),
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
            const conflict = new MoltenCommandConflictError(name, existing.modId, modId);
            runtime.conflict ??= conflict;
            throw conflict;
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
    stopRuntime(runtime: ModRuntime, state: MoltenModState, error: string, title: string = null): void {
        if (runtime.stopped) {
            return;
        }
        this.disposeRuntime(runtime);
        runtime.status.state = state;
        runtime.status.error = error;
        runtime.status.commands = [];
        delete runtime.status.usage;
        this.publish();
        console.error(`[molten:${runtime.status.id}] ${state}: ${error}`);
        this.notify({
            title:
                title ??
                t(state === "refused" ? "molten.notify.refused" : "molten.notify.stopped", { id: runtime.status.id }),
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
        this.notificationListener?.(entry);
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
