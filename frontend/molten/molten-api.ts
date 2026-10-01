// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenApi is the only surface a mod sees (DS-MORPH-002, DS-MORPH-005). It hands out plain functions and data,
// never Wave objects, so that mods survive upstream changes and can later move into a sandbox unchanged.

import type { MoltenModManifest } from "./molten-manifest";

export const MoltenApiVersion = 1;

// Names the molten command keeps for itself (FR-MORPH-003, FR-MORPH-005, FR-MORPH-006).
export const MoltenReservedCommandNames = ["mod", "help", "undo", "history", "agent", "docs"];

const CommandNamePattern = /^[a-z][a-z0-9-]*$/;

export type MoltenDisposer = () => void;

export type MoltenCommandContext = {
    args: string[];
    stdin?: string;
    blockId?: string;
};

export type MoltenCommandResult = string | { output?: string; exitCode?: number } | void;

export type MoltenCommandHandler = (ctx: MoltenCommandContext) => MoltenCommandResult | Promise<MoltenCommandResult>;

export type MoltenCommandOptions = {
    description?: string;
};

export type MoltenNotificationKind = "info" | "success" | "warning" | "error";

export type MoltenNotificationOptions = {
    title: string;
    message?: string;
    kind?: MoltenNotificationKind;
};

export type MoltenApi = {
    apiVersion: number;
    mod: { id: string; name: string; version: string };
    commands: {
        register(name: string, handler: MoltenCommandHandler, opts?: MoltenCommandOptions): MoltenDisposer;
    };
    notifications: {
        show(opts: MoltenNotificationOptions): MoltenDisposer;
    };
    clipboard: {
        writeText(text: string): Promise<void>;
    };
    log: {
        info(...args: any[]): void;
        warn(...args: any[]): void;
        error(...args: any[]): void;
    };
};

// What the host provides to one mod's API. `track` remembers a disposer so that stopping the mod undoes it; `fail`
// stops the mod and reports the error.
export type MoltenApiBackend = {
    isStopped(): boolean;
    track(dispose: MoltenDisposer): MoltenDisposer;
    fail(err: unknown): void;
    registerCommand(name: string, description: string, handler: MoltenCommandHandler): MoltenDisposer;
    showNotification(opts: MoltenNotificationOptions): MoltenDisposer;
    writeClipboard(text: string): Promise<void>;
};

export function validateMoltenCommandName(name: unknown): string {
    if (typeof name !== "string" || !CommandNamePattern.test(name)) {
        return `command name must use lowercase letters, digits and "-" and start with a letter (got ${JSON.stringify(name)})`;
    }
    if (MoltenReservedCommandNames.includes(name)) {
        return `command name "${name}" is reserved by molten`;
    }
    return null;
}

export function makeMoltenApi(manifest: MoltenModManifest, backend: MoltenApiBackend): MoltenApi {
    const prefix = `[molten:${manifest.id}]`;
    const ensureRunning = () => {
        if (backend.isStopped()) {
            throw new Error(`mod "${manifest.id}" is stopped`);
        }
    };
    // A throw from a handler stops the whole mod (FR-MORPH-001): its other registrations may rely on state the
    // failed handler left half-updated.
    const wrapHandler = (handler: MoltenCommandHandler): MoltenCommandHandler => {
        return async (ctx) => {
            ensureRunning();
            try {
                return await handler(ctx);
            } catch (e) {
                backend.fail(e);
                throw e;
            }
        };
    };
    return Object.freeze({
        apiVersion: MoltenApiVersion,
        mod: Object.freeze({ id: manifest.id, name: manifest.name, version: manifest.version }),
        commands: Object.freeze({
            register(name: string, handler: MoltenCommandHandler, opts?: MoltenCommandOptions): MoltenDisposer {
                ensureRunning();
                const nameError = validateMoltenCommandName(name);
                if (nameError != null) {
                    throw new Error(nameError);
                }
                if (typeof handler !== "function") {
                    throw new Error(`command "${name}": the handler must be a function`);
                }
                return backend.track(backend.registerCommand(name, opts?.description ?? "", wrapHandler(handler)));
            },
        }),
        notifications: Object.freeze({
            show(opts: MoltenNotificationOptions): MoltenDisposer {
                ensureRunning();
                if (opts == null || typeof opts.title !== "string" || opts.title === "") {
                    throw new Error("notifications.show: a non-empty title is required");
                }
                return backend.track(backend.showNotification(opts));
            },
        }),
        clipboard: Object.freeze({
            async writeText(text: string): Promise<void> {
                ensureRunning();
                await backend.writeClipboard(String(text));
            },
        }),
        log: Object.freeze({
            info: (...args: any[]) => console.log(prefix, ...args),
            warn: (...args: any[]) => console.warn(prefix, ...args),
            error: (...args: any[]) => console.error(prefix, ...args),
        }),
    });
}
