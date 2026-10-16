// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { SecretsContent } from "@/app/view/waveconfig/secretscontent";
import { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { atom, Provider, type Atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import { SecretsSection } from "./settings-secrets";

vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({ makeORef: (kind: string, id: string) => `${kind}:${id}` }));
vi.mock("./settings-view", () => ({ MoltentermSettingsView: () => null }));

function deferred<T>() {
    let resolve: (value: T) => void;
    let reject: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function fixture() {
    const stored: Record<string, string> = { AUDIT_FIXTURE: "fixture-original", OTHER_FIXTURE: "fixture-other" };
    const rpc = {
        FileInfoCommand: vi.fn(async () => ({ notfound: true })),
        GetSecretsLinuxStorageBackendCommand: vi.fn(async () => "keychain"),
        GetSecretsNamesCommand: vi.fn(async () => Object.keys(stored)),
        GetSecretsCommand: vi.fn(async (_client: unknown, names: string[]) =>
            Object.fromEntries(names.filter((name) => name in stored).map((name) => [name, stored[name]]))
        ),
        SetSecretsCommand: vi.fn(async (_client: unknown, updates: Record<string, string>) => {
            for (const [name, value] of Object.entries(updates)) {
                if (value == null) delete stored[name];
                else stored[name] = value;
            }
        }),
        RecordTEventCommand: vi.fn(),
    };
    const model = new WaveConfigViewModel({
        blockId: "secrets-fixture",
        waveEnv: {
            electron: { getConfigDir: () => "/fixture/config", getPlatform: () => "darwin" },
            rpc,
            atoms: { fullConfigAtom: atom(null) },
            getBlockMetaKeyAtom: () => atom(null),
            isWindows: () => false,
        },
    } as unknown as ViewModelInitType);
    globalStore.set(model.secretNamesAtom, Object.keys(stored));
    globalStore.set(model.secretNamesReadyAtom, true);
    return { model, rpc, stored };
}

function expectLiveError(errorAtom: Atom<string>, key: string, vars?: Record<string, string>) {
    const i18n = I18nModel.getInstance();
    i18n.setLanguageSetting("en");
    expect(globalStore.get(errorAtom)).toBe(translate("en", key, vars));
    i18n.setLanguageSetting("fr");
    expect(globalStore.get(errorAtom)).toBe(translate("fr", key, vars));
    expect(globalStore.get(errorAtom)).not.toContain("rpc-sensitive-diagnostic");
    expect(translate("en", key, vars)).not.toBe(translate("fr", key, vars));
}

beforeEach(() => I18nModel.getInstance().setLanguageSetting("en"));
afterEach(() => I18nModel.getInstance().setLanguageSetting("en"));

describe("Secrets draft ownership (#813)", () => {
    it("never writes an untouched hidden, revealed, failed-reveal, or cancelled value", async () => {
        const { model, rpc, stored } = fixture();
        await model.viewSecret("AUDIT_FIXTURE");
        await model.saveSecret();
        expect(globalStore.get(model.secretCanSaveAtom)).toBe(false);
        await model.showSecret();
        expect(globalStore.get(model.secretValueAtom)).toBe(stored.AUDIT_FIXTURE);
        await model.saveSecret();
        await model.viewSecret("AUDIT_FIXTURE");
        rpc.GetSecretsCommand.mockRejectedValueOnce(new Error("rpc-sensitive-diagnostic"));
        await model.showSecret();
        await model.saveSecret();
        model.editSecretValue("fixture-replacement");
        model.closeSecretView();
        await model.saveSecret();
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
        expect(stored.AUDIT_FIXTURE).toBe("fixture-original");
    });

    it.each(["fixture-replacement", ""])(
        "saves a deliberate replacement, including an explicit empty value (%j)",
        async (value) => {
            const { model, rpc, stored } = fixture();
            await model.viewSecret("AUDIT_FIXTURE");
            model.editSecretValue("typed-before-clearing");
            model.editSecretValue(value);
            expect(globalStore.get(model.secretCanSaveAtom)).toBe(true);
            await model.saveSecret();
            expect(rpc.SetSecretsCommand).toHaveBeenCalledExactlyOnceWith({}, { AUDIT_FIXTURE: value });
            expect(stored.AUDIT_FIXTURE).toBe(value);
            expect(globalStore.get(model.selectedSecretAtom)).toBeNull();
            expect(globalStore.get(model.secretValueAtom)).toBe("");
        }
    );

    it("keeps a failed save draft for retry without leaking its RPC diagnostic", async () => {
        const { model, rpc, stored } = fixture();
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("fixture-replacement");
        rpc.SetSecretsCommand.mockRejectedValueOnce(new Error("rpc-sensitive-diagnostic"));
        await model.saveSecret();
        expect(stored.AUDIT_FIXTURE).toBe("fixture-original");
        expect(globalStore.get(model.secretValueAtom)).toBe("fixture-replacement");
        expect(globalStore.get(model.secretCanSaveAtom)).toBe(true);
        expectLiveError(model.secretErrorAtom, "settings.secrets.errors.save");
        await model.refreshSecrets();
        expectLiveError(model.secretErrorAtom, "settings.secrets.errors.save");
        await model.saveSecret();
        expect(stored.AUDIT_FIXTURE).toBe("fixture-replacement");
        expect(rpc.SetSecretsCommand).toHaveBeenCalledTimes(2);
    });

    it("does not submit the previous selection's draft under a new name", async () => {
        const { model, rpc, stored } = fixture();
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("fixture-replacement");
        await model.viewSecret("OTHER_FIXTURE");
        await model.saveSecret();
        expect(globalStore.get(model.secretValueAtom)).toBe("");
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
        expect(stored.OTHER_FIXTURE).toBe("fixture-other");
    });

    it.each([SecretsSection, SecretsContent])(
        "disables unchanged Save in both settings renderers",
        async (Component) => {
            const { model } = fixture();
            await model.viewSecret("AUDIT_FIXTURE");
            const render = () =>
                renderToStaticMarkup(
                    <Provider store={globalStore}>
                        <Component model={model} />
                    </Provider>
                );
            const saveButton = () => render().match(/<button\b[^>]*>Save(?:<|\s)/)?.[0];
            expect(saveButton()).toContain('disabled=""');
            model.editSecretValue("fixture-replacement");
            expect(saveButton()).not.toContain('disabled=""');
        }
    );
});

describe("Secrets asynchronous responses (#813)", () => {
    it.each([
        ["save", "save"],
        ["save", "delete"],
        ["delete", "save"],
        ["delete", "delete"],
    ])("keeps a pending %s from being overtaken by a later %s after reopening", async (first, next) => {
        const { model, rpc, stored } = fixture();
        const write = deferred<void>();
        rpc.SetSecretsCommand.mockImplementationOnce(async (_client, updates) => {
            await write.promise;
            for (const [name, value] of Object.entries(updates)) {
                if (value == null) delete stored[name];
                else stored[name] = value;
            }
        });
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("older-draft");
        const pending = first === "save" ? model.saveSecret() : model.deleteSecret();
        model.closeSecretView();
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("newer-draft");
        if (next === "save") await model.saveSecret();
        else await model.deleteSecret();
        expect(rpc.SetSecretsCommand).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.secretOperationBusyAtom)).toBe(true);
        expect(globalStore.get(model.secretCanSaveAtom)).toBe(false);
        write.resolve();
        await pending;
        expect(globalStore.get(model.secretValueAtom)).toBe("newer-draft");
        if (next === "save") await model.saveSecret();
        else await model.deleteSecret();
        expect(rpc.SetSecretsCommand).toHaveBeenCalledTimes(2);
        expect(stored.AUDIT_FIXTURE).toBe(next === "save" ? "newer-draft" : undefined);
    });

    it("does not let a cancelled pending add be overtaken by another add of the same name", async () => {
        const { model, rpc, stored } = fixture();
        const write = deferred<void>();
        rpc.SetSecretsCommand.mockImplementationOnce(async (_client, updates) => {
            await write.promise;
            Object.assign(stored, updates);
        });
        model.startAddingSecret();
        globalStore.set(model.newSecretNameAtom, "NEW_FIXTURE");
        globalStore.set(model.newSecretValueAtom, "first-value");
        const pending = model.addNewSecret();
        model.cancelAddingSecret();
        model.startAddingSecret();
        globalStore.set(model.newSecretNameAtom, "NEW_FIXTURE");
        globalStore.set(model.newSecretValueAtom, "second-value");
        await model.addNewSecret();
        expect(rpc.SetSecretsCommand).toHaveBeenCalledTimes(1);
        write.resolve();
        await pending;
        await model.addNewSecret();
        expectLiveError(model.secretErrorAtom, "settings.secrets.errors.duplicate", { name: "NEW_FIXTURE" });
        expect(rpc.SetSecretsCommand).toHaveBeenCalledTimes(1);
        expect(stored.NEW_FIXTURE).toBe("first-value");
        expect(globalStore.get(model.newSecretValueAtom)).toBe("second-value");
    });

    it("never upserts an existing secret before the first names response or after a list failure", async () => {
        const { model, rpc, stored } = fixture();
        globalStore.set(model.secretNamesAtom, []);
        globalStore.set(model.secretNamesReadyAtom, false);
        model.startAddingSecret();
        globalStore.set(model.newSecretNameAtom, "AUDIT_FIXTURE");
        globalStore.set(model.newSecretValueAtom, "would-overwrite");
        await model.addNewSecret();
        const list = deferred<string[]>();
        rpc.GetSecretsNamesCommand.mockReturnValueOnce(list.promise);
        const pending = model.refreshSecrets();
        await model.addNewSecret();
        list.reject(new Error("rpc-sensitive-diagnostic"));
        await pending;
        await model.addNewSecret();
        expect(globalStore.get(model.secretCanAddAtom)).toBe(false);
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
        expect(stored.AUDIT_FIXTURE).toBe("fixture-original");
        await model.refreshSecrets();
        await model.addNewSecret();
        expectLiveError(model.secretErrorAtom, "settings.secrets.errors.duplicate", { name: "AUDIT_FIXTURE" });
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
    });

    it("allows a new name only after a successful names load", async () => {
        const { model, rpc, stored } = fixture();
        globalStore.set(model.secretNamesReadyAtom, false);
        model.startAddingSecret();
        globalStore.set(model.newSecretNameAtom, "NEW_FIXTURE");
        globalStore.set(model.newSecretValueAtom, "fixture-new");
        await model.addNewSecret();
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
        await model.refreshSecrets();
        await model.addNewSecret();
        expect(stored.NEW_FIXTURE).toBe("fixture-new");
        expect(rpc.SetSecretsCommand).toHaveBeenCalledTimes(1);
    });

    it.each(["switch", "return", "cancel", "edit"])("ignores an old reveal after %s", async (action) => {
        const { model, rpc } = fixture();
        const reveal = deferred<Record<string, string>>();
        rpc.GetSecretsCommand.mockReturnValueOnce(reveal.promise);
        await model.viewSecret("AUDIT_FIXTURE");
        const pending = model.showSecret();
        if (action === "cancel") model.closeSecretView();
        else if (action === "edit") model.editSecretValue("new-draft");
        else {
            await model.viewSecret("OTHER_FIXTURE");
            if (action === "return") await model.viewSecret("AUDIT_FIXTURE");
        }
        reveal.resolve({ AUDIT_FIXTURE: "old-reveal" });
        await pending;
        expect(globalStore.get(model.secretValueAtom)).toBe(action === "edit" ? "new-draft" : "");
        expect(globalStore.get(model.secretShownAtom)).toBe(false);
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
    });

    it("an old reveal's finally cannot clear the new selection's busy state", async () => {
        const { model, rpc } = fixture();
        const first = deferred<Record<string, string>>();
        const second = deferred<Record<string, string>>();
        rpc.GetSecretsCommand.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await model.viewSecret("AUDIT_FIXTURE");
        const oldRequest = model.showSecret();
        await model.viewSecret("OTHER_FIXTURE");
        const newRequest = model.showSecret();
        first.reject(new Error("rpc-sensitive-diagnostic"));
        await oldRequest;
        expect(globalStore.get(model.secretBusyAtom)).toBe(true);
        expect(globalStore.get(model.secretErrorAtom)).toBeNull();
        second.resolve({ OTHER_FIXTURE: "fixture-other" });
        await newRequest;
        expect(globalStore.get(model.secretBusyAtom)).toBe(false);
        expect(globalStore.get(model.secretValueAtom)).toBe("fixture-other");
    });

    it.each(["save", "delete"] as const)("old %s success cannot close a new draft", async (operation) => {
        const { model, rpc } = fixture();
        const write = deferred<void>();
        rpc.SetSecretsCommand.mockReturnValueOnce(write.promise);
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("first-draft");
        const pending = operation === "save" ? model.saveSecret() : model.deleteSecret();
        await model.viewSecret("OTHER_FIXTURE");
        model.editSecretValue("second-draft");
        write.resolve();
        await pending;
        expect(rpc.SetSecretsCommand).toHaveBeenCalledExactlyOnceWith(
            {},
            {
                AUDIT_FIXTURE: operation === "save" ? "first-draft" : null,
            }
        );
        expect(globalStore.get(model.selectedSecretAtom)).toBe("OTHER_FIXTURE");
        expect(globalStore.get(model.secretValueAtom)).toBe("second-draft");
        expect(globalStore.get(model.secretCanSaveAtom)).toBe(true);
    });

    it.each(["save", "delete"] as const)("old %s failure cannot contaminate a new selection", async (operation) => {
        const { model, rpc } = fixture();
        const write = deferred<void>();
        rpc.SetSecretsCommand.mockReturnValueOnce(write.promise);
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("first-draft");
        const pending = operation === "save" ? model.saveSecret() : model.deleteSecret();
        model.closeSecretView();
        await model.viewSecret("AUDIT_FIXTURE");
        write.reject(new Error("rpc-sensitive-diagnostic"));
        await pending;
        expect(globalStore.get(model.secretErrorAtom)).toBeNull();
        expect(globalStore.get(model.secretCanSaveAtom)).toBe(false);
    });

    it("retains edits made while a save is pending and refuses a duplicate save", async () => {
        const { model, rpc } = fixture();
        const write = deferred<void>();
        rpc.SetSecretsCommand.mockReturnValueOnce(write.promise);
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("first-draft");
        const pending = model.saveSecret();
        model.editSecretValue("newer-draft");
        await model.saveSecret();
        write.resolve();
        await pending;
        expect(rpc.SetSecretsCommand).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.secretValueAtom)).toBe("newer-draft");
        expect(globalStore.get(model.secretCanSaveAtom)).toBe(true);
    });

    it("keeps list requests separate from editor operations and ignores obsolete lists", async () => {
        const { model, rpc } = fixture();
        const oldList = deferred<string[]>();
        const newList = deferred<string[]>();
        const reveal = deferred<Record<string, string>>();
        rpc.GetSecretsNamesCommand.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise);
        rpc.GetSecretsCommand.mockReturnValueOnce(reveal.promise);
        const first = model.refreshSecrets();
        const second = model.refreshSecrets();
        await model.viewSecret("AUDIT_FIXTURE");
        const showing = model.showSecret();
        oldList.resolve(["OBSOLETE_FIXTURE"]);
        await first;
        expect(globalStore.get(model.secretsLoadingAtom)).toBe(true);
        newList.resolve(["AUDIT_FIXTURE"]);
        await second;
        expect(globalStore.get(model.secretNamesAtom)).toEqual(["AUDIT_FIXTURE"]);
        expect(globalStore.get(model.secretBusyAtom)).toBe(true);
        reveal.resolve({ AUDIT_FIXTURE: "fixture-original" });
        await showing;
    });

    it("a cancelled add cannot clear a later editor or its draft", async () => {
        const { model, rpc } = fixture();
        const write = deferred<void>();
        rpc.SetSecretsCommand.mockReturnValueOnce(write.promise);
        model.startAddingSecret();
        globalStore.set(model.newSecretNameAtom, "NEW_FIXTURE");
        globalStore.set(model.newSecretValueAtom, "new-value");
        const pending = model.addNewSecret();
        model.cancelAddingSecret();
        await model.viewSecret("AUDIT_FIXTURE");
        model.editSecretValue("newer-draft");
        write.resolve();
        await pending;
        expect(globalStore.get(model.selectedSecretAtom)).toBe("AUDIT_FIXTURE");
        expect(globalStore.get(model.secretValueAtom)).toBe("newer-draft");
    });
});

describe("Secrets failure translations (#813)", () => {
    it.each([
        ["", "emptyName"],
        ["invalid-name", "invalidName"],
        ["AUDIT_FIXTURE", "duplicate"],
    ])("localizes name validation for %j without a write", async (name, code) => {
        const { model, rpc } = fixture();
        model.startAddingSecret();
        globalStore.set(model.newSecretNameAtom, name);
        await model.addNewSecret();
        expectLiveError(
            model.secretErrorAtom,
            `settings.secrets.errors.${code}`,
            code === "duplicate" ? { name } : null
        );
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
    });

    it.each(["list", "reveal", "delete", "add"])(
        "localizes the %s RPC failure without exposing diagnostics",
        async (operation) => {
            const { model, rpc } = fixture();
            const error = new Error("rpc-sensitive-diagnostic");
            if (operation === "list") {
                rpc.GetSecretsNamesCommand.mockRejectedValueOnce(error);
                await model.refreshSecrets();
            } else if (operation === "reveal") {
                await model.viewSecret("AUDIT_FIXTURE");
                rpc.GetSecretsCommand.mockRejectedValueOnce(error);
                await model.showSecret();
            } else if (operation === "delete") {
                await model.viewSecret("AUDIT_FIXTURE");
                rpc.SetSecretsCommand.mockRejectedValueOnce(error);
                await model.deleteSecret();
            } else {
                model.startAddingSecret();
                globalStore.set(model.newSecretNameAtom, "NEW_FIXTURE");
                globalStore.set(model.newSecretValueAtom, "fixture-new");
                rpc.SetSecretsCommand.mockRejectedValueOnce(error);
                await model.addNewSecret();
                expect(globalStore.get(model.newSecretValueAtom)).toBe("fixture-new");
            }
            expectLiveError(model.secretErrorAtom, `settings.secrets.errors.${operation}`);
        }
    );

    it("localizes a missing entry and keeps Save unavailable", async () => {
        const { model, rpc } = fixture();
        await model.viewSecret("MISSING_FIXTURE");
        await model.showSecret();
        expectLiveError(model.secretErrorAtom, "settings.secrets.errors.missing", { name: "MISSING_FIXTURE" });
        await model.saveSecret();
        expect(rpc.SetSecretsCommand).not.toHaveBeenCalled();
    });

    it.each(["basic_text", "unknown", "failure"])("localizes an unavailable storage backend (%s)", async (backend) => {
        const { model, rpc } = fixture();
        if (backend === "failure")
            rpc.GetSecretsLinuxStorageBackendCommand.mockRejectedValueOnce(new Error("rpc-sensitive-diagnostic"));
        else rpc.GetSecretsLinuxStorageBackendCommand.mockResolvedValueOnce(backend);
        await model.checkStorageBackend();
        expectLiveError(
            model.storageBackendErrorAtom,
            `settings.secrets.errors.${backend === "failure" ? "storageCheck" : "storageUnavailable"}`
        );
    });
});
