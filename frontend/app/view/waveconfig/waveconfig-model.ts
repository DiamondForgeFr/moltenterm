// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { makeORef } from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { SecretsContent } from "@/app/view/waveconfig/secretscontent";
import type { WaveConfigEnv } from "@/app/view/waveconfig/waveconfigenv";
import { MoltentermNoAI } from "@/util/moltenterm-noai"; // MOLTENTERM-PATCH (#25)
import { base64ToString, stringToBase64 } from "@/util/util";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import * as React from "react";
import { I18nModel } from "../../../moltenterm-shell/i18n/i18n"; // MOLTENTERM-PATCH (#623)
import { translate, type I18nVars } from "../../../moltenterm-shell/i18n/i18n-core"; // MOLTENTERM-PATCH (#623, #813)
import { MoltentermSettingsView } from "../../../moltenterm-shell/settings/settings-view"; // MOLTENTERM-PATCH (#404)

type ValidationResult = { success: true } | { error: string };
type ConfigValidator = (parsed: any) => ValidationResult;
// MOLTENTERM-PATCH (#813): errors stay translatable without retaining RPC diagnostics or secret values.
type SecretError = { key: string; vars?: I18nVars };

export type ConfigFile = {
    name: string;
    path: string;
    language?: string;
    deprecated?: boolean;
    description?: string;
    docsUrl?: string;
    validator?: ConfigValidator;
    isSecrets?: boolean;
    hasJsonView?: boolean;
    visualComponent?: React.ComponentType<{ model: WaveConfigViewModel }>;
};

export const SecretNameRegex = /^[A-Za-z][A-Za-z0-9_]*$/;

function validateAiJson(parsed: any): ValidationResult {
    const keys = Object.keys(parsed);
    for (const key of keys) {
        if (!key.startsWith("ai@")) {
            return { error: `Invalid key "${key}": all top-level keys must start with "ai@"` };
        }
    }
    return { success: true };
}

function validateWaveAiJson(parsed: any): ValidationResult {
    const keys = Object.keys(parsed);
    const keyPattern = /^[a-zA-Z0-9_@.-]+$/;
    for (const key of keys) {
        if (!keyPattern.test(key)) {
            return {
                error: `Invalid key "${key}": keys must only contain letters, numbers, underscores, @, dots, and hyphens`,
            };
        }
    }
    return { success: true };
}

// MOLTENTERM-PATCH (#1406): exported for the library's Advanced block, which lists the same files.
export function makeConfigFiles(isWindows: boolean): ConfigFile[] {
    return [
        {
            name: "Settings", // MOLTENTERM-PATCH (#404): Wave named it General
            path: "settings.json",
            language: "json",
            docsUrl: "https://docs.waveterm.dev/config",
            hasJsonView: true,
        },
        {
            name: "Connections",
            path: "connections.json",
            language: "json",
            docsUrl: "https://docs.waveterm.dev/connections",
            description: isWindows ? "SSH hosts and WSL distros" : "SSH hosts",
            hasJsonView: true,
        },
        {
            name: "Rail widgets", // MOLTENTERM-PATCH (#404): the rail replaces Wave's sidebar
            path: "widgets.json",
            language: "json",
            docsUrl: "https://docs.waveterm.dev/customwidgets",
            hasJsonView: true,
        },
        {
            name: "Wave AI Modes",
            path: "waveai.json",
            language: "json",
            description: "Local models and BYOK",
            docsUrl: "https://docs.waveterm.dev/waveai-modes",
            validator: validateWaveAiJson,
            hasJsonView: true,
            // visualComponent: WaveAIVisualContent,
        },
        {
            name: "Tab backgrounds", // MOLTENTERM-PATCH (#404): sentence case
            path: "backgrounds.json",
            language: "json",
            docsUrl: "https://docs.waveterm.dev/tab-backgrounds",
            hasJsonView: true,
        },
        {
            name: "Secrets",
            path: "secrets",
            isSecrets: true,
            hasJsonView: false,
            visualComponent: SecretsContent,
        },
    ].filter((file) => !MoltentermNoAI || file.path !== "waveai.json"); // MOLTENTERM-PATCH (#25): no AI modes file
}

const deprecatedConfigFiles: ConfigFile[] = [
    {
        name: "Presets",
        path: "presets.json",
        language: "json",
        deprecated: true,
        hasJsonView: true,
    },
    {
        name: "AI Presets",
        path: "presets/ai.json",
        language: "json",
        deprecated: true,
        docsUrl: "https://docs.waveterm.dev/ai-presets",
        validator: validateAiJson,
        hasJsonView: true,
    },
].filter((file) => !MoltentermNoAI || file.path !== "presets/ai.json"); // MOLTENTERM-PATCH (#25): no AI presets file

export class WaveConfigViewModel implements ViewModel {
    blockId: string;
    viewType = "waveconfig";
    viewIcon = atom("gear");
    viewName = atom((get) => translate(get(I18nModel.getInstance().localeAtom), "settings.title")); // MOLTENTERM-PATCH (#404, #623): no screen is titled Wave Config; in the interface language
    viewComponent = MoltentermSettingsView; // MOLTENTERM-PATCH (#404): the settings screen, Wave's editor under Advanced
    noPadding = atom(true);
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    env: WaveConfigEnv;

    selectedFileAtom: PrimitiveAtom<ConfigFile>;
    fileContentAtom: PrimitiveAtom<string>;
    originalContentAtom: PrimitiveAtom<string>;
    hasEditedAtom: PrimitiveAtom<boolean>;
    isLoadingAtom: PrimitiveAtom<boolean>;
    isSavingAtom: PrimitiveAtom<boolean>;
    errorMessageAtom: PrimitiveAtom<string>;
    validationErrorAtom: PrimitiveAtom<string>;
    isMenuOpenAtom: PrimitiveAtom<boolean>;
    presetsJsonExistsAtom: PrimitiveAtom<boolean>;
    activeTabAtom: PrimitiveAtom<"visual" | "json">;
    configErrorFilesAtom: Atom<Set<string>>;
    configDir: string;
    saveShortcut: string;
    editorRef: React.RefObject<MonacoTypes.editor.IStandaloneCodeEditor>;

    secretNamesAtom: PrimitiveAtom<string[]>;
    selectedSecretAtom: PrimitiveAtom<string | null>;
    secretValueAtom: Atom<string>;
    secretDraftAtom = atom("");
    secretEditedAtom = atom(false);
    secretBusyAtom = atom(false);
    secretMutationBusyAtom = atom(false);
    secretOperationBusyAtom: Atom<boolean>;
    secretsLoadingAtom = atom(false);
    secretNamesReadyAtom = atom(false);
    secretCanSaveAtom: Atom<boolean>;
    secretCanAddAtom: Atom<boolean>;
    secretEditorErrorAtom = atom(null) as PrimitiveAtom<SecretError>;
    secretListErrorAtom = atom(null) as PrimitiveAtom<SecretError>;
    secretErrorAtom: Atom<string>;
    storageBackendErrorKeyAtom = atom(null) as PrimitiveAtom<string>;
    secretGeneration = 0;
    secretDraftRevision = 0;
    secretListRequest = 0;
    secretBackendRequest = 0;
    secretShownAtom: PrimitiveAtom<boolean>;
    isAddingNewAtom: PrimitiveAtom<boolean>;
    newSecretNameAtom: PrimitiveAtom<string>;
    newSecretValueAtom: PrimitiveAtom<string>;
    storageBackendErrorAtom: Atom<string>;
    secretValueRef: HTMLTextAreaElement | null = null;

    constructor({ blockId, nodeModel, tabModel, waveEnv }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.env = waveEnv as WaveConfigEnv;
        this.configDir = this.env.electron.getConfigDir();
        const platform = this.env.electron.getPlatform();
        this.saveShortcut = platform === "darwin" ? "Cmd+S" : "Alt+S";

        this.selectedFileAtom = atom(null) as PrimitiveAtom<ConfigFile>;
        this.fileContentAtom = atom("");
        this.originalContentAtom = atom("");
        this.hasEditedAtom = atom(false);
        this.isLoadingAtom = atom(false);
        this.isSavingAtom = atom(false);
        this.errorMessageAtom = atom(null) as PrimitiveAtom<string>;
        this.validationErrorAtom = atom(null) as PrimitiveAtom<string>;
        this.isMenuOpenAtom = atom(false);
        this.presetsJsonExistsAtom = atom(false);
        this.activeTabAtom = atom<"visual" | "json">("visual");
        this.configErrorFilesAtom = atom((get) => {
            const fullConfig = get(this.env.atoms.fullConfigAtom);
            const errorSet = new Set<string>();
            for (const cerr of fullConfig?.configerrors ?? []) {
                errorSet.add(cerr.file);
            }
            return errorSet;
        });
        this.editorRef = React.createRef();

        this.secretNamesAtom = atom<string[]>([]);
        this.selectedSecretAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
        // MOLTENTERM-PATCH (#813): only explicit edits can make a hidden or revealed value saveable.
        this.secretValueAtom = atom((get) => get(this.secretDraftAtom));
        this.secretOperationBusyAtom = atom((get) => get(this.secretBusyAtom) || get(this.secretMutationBusyAtom));
        this.secretCanSaveAtom = atom(
            (get) => !!get(this.selectedSecretAtom) && get(this.secretEditedAtom) && !get(this.secretOperationBusyAtom)
        );
        this.secretCanAddAtom = atom(
            (get) =>
                get(this.isAddingNewAtom) &&
                get(this.secretNamesReadyAtom) &&
                !get(this.secretsLoadingAtom) &&
                !get(this.secretOperationBusyAtom)
        );
        this.secretErrorAtom = atom((get) => {
            const error = get(this.secretEditorErrorAtom) ?? get(this.secretListErrorAtom);
            const locale = get(I18nModel.getInstance().localeAtom);
            return error ? translate(locale, error.key, error.vars) : null;
        });
        this.secretShownAtom = atom<boolean>(false);
        this.isAddingNewAtom = atom<boolean>(false);
        this.newSecretNameAtom = atom<string>("");
        this.newSecretValueAtom = atom<string>("");
        this.storageBackendErrorAtom = atom((get) => {
            const key = get(this.storageBackendErrorKeyAtom);
            const locale = get(I18nModel.getInstance().localeAtom);
            return key ? translate(locale, key) : null;
        });

        this.checkPresetsJsonExists();
        this.initialize();
    }

    async checkPresetsJsonExists() {
        try {
            const fullPath = `${this.configDir}/presets.json`;
            const fileInfo = await this.env.rpc.FileInfoCommand(TabRpcClient, {
                info: { path: fullPath },
            });
            if (!fileInfo.notfound) {
                globalStore.set(this.presetsJsonExistsAtom, true);
            }
        } catch {
            // File doesn't exist
        }
    }

    initialize() {
        const selectedFile = globalStore.get(this.selectedFileAtom);
        if (!selectedFile) {
            const metaFileAtom = this.env.getBlockMetaKeyAtom(this.blockId, "file");
            const savedFilePath = globalStore.get(metaFileAtom);
            const configFiles = this.getConfigFiles();
            const deprecatedConfigFiles = this.getDeprecatedConfigFiles();

            let fileToLoad: ConfigFile | null = null;
            if (savedFilePath) {
                fileToLoad =
                    configFiles.find((f) => f.path === savedFilePath) ||
                    deprecatedConfigFiles.find((f) => f.path === savedFilePath) ||
                    null;
            }

            // MOLTENTERM-PATCH (#404): without a file the settings screen shows; a JSON file opens from Advanced.

            if (fileToLoad) {
                this.loadFile(fileToLoad);
            }
        }
    }

    getConfigFiles(): ConfigFile[] {
        return makeConfigFiles(this.env.isWindows());
    }

    getDeprecatedConfigFiles(): ConfigFile[] {
        const presetsJsonExists = globalStore.get(this.presetsJsonExistsAtom);
        return deprecatedConfigFiles.filter((f) => {
            if (f.path === "presets.json") {
                return presetsJsonExists;
            }
            return true;
        });
    }

    hasChanges(): boolean {
        return globalStore.get(this.hasEditedAtom);
    }

    confirmDiscardChanges(): boolean {
        if (!this.hasChanges()) {
            return true;
        }
        return window.confirm("You have unsaved changes. Discard and continue?");
    }

    discardChanges() {
        const originalContent = globalStore.get(this.originalContentAtom);
        globalStore.set(this.fileContentAtom, originalContent);
        globalStore.set(this.hasEditedAtom, false);
        globalStore.set(this.validationErrorAtom, null);
        globalStore.set(this.errorMessageAtom, null);
    }

    markAsEdited() {
        globalStore.set(this.hasEditedAtom, true);
    }

    async loadFile(file: ConfigFile) {
        globalStore.set(this.isLoadingAtom, true);
        globalStore.set(this.errorMessageAtom, null);
        globalStore.set(this.hasEditedAtom, false);

        if (file.isSecrets) {
            globalStore.set(this.selectedFileAtom, file);
            this.env.rpc.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: { file: file.path },
            });
            globalStore.set(this.isLoadingAtom, false);
            this.checkStorageBackend();
            this.refreshSecrets();
            return;
        }

        try {
            const fullPath = `${this.configDir}/${file.path}`;
            const fileData = await this.env.rpc.FileReadCommand(TabRpcClient, {
                info: { path: fullPath },
            });
            const content = fileData?.data64 ? base64ToString(fileData.data64) : "";
            globalStore.set(this.originalContentAtom, content);
            if (content.trim() === "") {
                globalStore.set(this.fileContentAtom, "{\n\n}");
            } else {
                globalStore.set(this.fileContentAtom, content);
            }
            globalStore.set(this.selectedFileAtom, file);
            this.env.rpc.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: { file: file.path },
            });
        } catch (err) {
            globalStore.set(this.errorMessageAtom, `Failed to load ${file.name}: ${err.message || String(err)}`);
            globalStore.set(this.fileContentAtom, "");
            globalStore.set(this.originalContentAtom, "");
        } finally {
            globalStore.set(this.isLoadingAtom, false);
        }
    }

    async saveFile() {
        const selectedFile = globalStore.get(this.selectedFileAtom);
        if (!selectedFile) return;

        const fileContent = globalStore.get(this.fileContentAtom);

        if (fileContent.trim() === "") {
            globalStore.set(this.isSavingAtom, true);
            globalStore.set(this.errorMessageAtom, null);
            globalStore.set(this.validationErrorAtom, null);

            try {
                const fullPath = `${this.configDir}/${selectedFile.path}`;
                await this.env.rpc.FileWriteCommand(TabRpcClient, {
                    info: { path: fullPath },
                    data64: stringToBase64(""),
                });
                globalStore.set(this.fileContentAtom, "");
                globalStore.set(this.originalContentAtom, "");
                globalStore.set(this.hasEditedAtom, false);
            } catch (err) {
                globalStore.set(
                    this.errorMessageAtom,
                    `Failed to save ${selectedFile.name}: ${err.message || String(err)}`
                );
            } finally {
                globalStore.set(this.isSavingAtom, false);
            }
            return;
        }

        try {
            const parsed = JSON.parse(fileContent);

            if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
                globalStore.set(this.validationErrorAtom, "JSON must be an object, not an array, primitive, or null");
                return;
            }

            if (selectedFile.validator) {
                const validationResult = selectedFile.validator(parsed);
                if ("error" in validationResult) {
                    globalStore.set(this.validationErrorAtom, validationResult.error);
                    return;
                }
            }

            const formatted = JSON.stringify(parsed, null, 2);

            globalStore.set(this.isSavingAtom, true);
            globalStore.set(this.errorMessageAtom, null);
            globalStore.set(this.validationErrorAtom, null);

            try {
                const fullPath = `${this.configDir}/${selectedFile.path}`;
                await this.env.rpc.FileWriteCommand(TabRpcClient, {
                    info: { path: fullPath },
                    data64: stringToBase64(formatted),
                });
                globalStore.set(this.fileContentAtom, formatted);
                globalStore.set(this.originalContentAtom, formatted);
                globalStore.set(this.hasEditedAtom, false);
            } catch (err) {
                globalStore.set(
                    this.errorMessageAtom,
                    `Failed to save ${selectedFile.name}: ${err.message || String(err)}`
                );
            } finally {
                globalStore.set(this.isSavingAtom, false);
            }
        } catch (err) {
            globalStore.set(this.validationErrorAtom, `Invalid JSON: ${err.message || String(err)}`);
        }
    }

    clearError() {
        globalStore.set(this.errorMessageAtom, null);
    }

    clearValidationError() {
        globalStore.set(this.validationErrorAtom, null);
    }

    async checkStorageBackend() {
        const request = ++this.secretBackendRequest;
        try {
            const backend = await this.env.rpc.GetSecretsLinuxStorageBackendCommand(TabRpcClient);
            if (request !== this.secretBackendRequest) return;
            globalStore.set(
                this.storageBackendErrorKeyAtom,
                backend === "basic_text" || backend === "unknown" ? "settings.secrets.errors.storageUnavailable" : null
            );
        } catch {
            if (request !== this.secretBackendRequest) return;
            globalStore.set(this.storageBackendErrorKeyAtom, "settings.secrets.errors.storageCheck");
        }
    }

    async refreshSecrets() {
        const request = ++this.secretListRequest;
        globalStore.set(this.secretsLoadingAtom, true);
        globalStore.set(this.secretNamesReadyAtom, false);
        globalStore.set(this.secretListErrorAtom, null);

        try {
            const names = await this.env.rpc.GetSecretsNamesCommand(TabRpcClient);
            if (request !== this.secretListRequest) return;
            globalStore.set(this.secretNamesAtom, names || []);
            globalStore.set(this.secretNamesReadyAtom, true);
        } catch {
            if (request !== this.secretListRequest) return;
            globalStore.set(this.secretListErrorAtom, { key: "settings.secrets.errors.list" });
        } finally {
            if (request === this.secretListRequest) globalStore.set(this.secretsLoadingAtom, false);
        }
    }

    async viewSecret(name: string) {
        this.resetSecretEditor();
        globalStore.set(this.selectedSecretAtom, name);
    }

    closeSecretView() {
        this.resetSecretEditor();
    }

    // MOLTENTERM-PATCH (#813): a new selection (including A → B → A) invalidates every old editor response.
    resetSecretEditor() {
        this.secretGeneration++;
        this.secretDraftRevision++;
        globalStore.set(this.selectedSecretAtom, null);
        globalStore.set(this.secretDraftAtom, "");
        globalStore.set(this.secretEditedAtom, false);
        globalStore.set(this.secretShownAtom, false);
        globalStore.set(this.secretBusyAtom, false);
        globalStore.set(this.secretEditorErrorAtom, null);
        globalStore.set(this.isAddingNewAtom, false);
        globalStore.set(this.newSecretNameAtom, "");
        globalStore.set(this.newSecretValueAtom, "");
    }

    editSecretValue(value: string) {
        if (!globalStore.get(this.selectedSecretAtom)) return;
        this.secretDraftRevision++;
        globalStore.set(this.secretDraftAtom, value);
        globalStore.set(this.secretEditedAtom, true);
        globalStore.set(this.secretEditorErrorAtom, null);
    }

    async showSecret() {
        const selectedSecret = globalStore.get(this.selectedSecretAtom);
        if (!selectedSecret || globalStore.get(this.secretOperationBusyAtom) || globalStore.get(this.secretEditedAtom))
            return;

        const generation = this.secretGeneration;
        const revision = this.secretDraftRevision;
        globalStore.set(this.secretBusyAtom, true);
        globalStore.set(this.secretEditorErrorAtom, null);

        try {
            const secrets = await this.env.rpc.GetSecretsCommand(TabRpcClient, [selectedSecret]);
            if (generation !== this.secretGeneration || revision !== this.secretDraftRevision) return;
            const value = secrets?.[selectedSecret];
            if (value != null) {
                globalStore.set(this.secretDraftAtom, value);
                globalStore.set(this.secretShownAtom, true);
            } else {
                globalStore.set(this.secretEditorErrorAtom, {
                    key: "settings.secrets.errors.missing",
                    vars: { name: selectedSecret },
                });
            }
        } catch {
            if (generation !== this.secretGeneration || revision !== this.secretDraftRevision) return;
            globalStore.set(this.secretEditorErrorAtom, { key: "settings.secrets.errors.reveal" });
        } finally {
            if (generation === this.secretGeneration) globalStore.set(this.secretBusyAtom, false);
        }
    }

    async saveSecret() {
        if (!globalStore.get(this.secretCanSaveAtom)) return;
        const selectedSecret = globalStore.get(this.selectedSecretAtom);
        const secretValue = globalStore.get(this.secretValueAtom);
        const generation = this.secretGeneration;
        const revision = this.secretDraftRevision;

        globalStore.set(this.secretBusyAtom, true);
        globalStore.set(this.secretEditorErrorAtom, null);

        try {
            await this.writeSecrets({ [selectedSecret]: secretValue });
            this.env.rpc.RecordTEventCommand(
                TabRpcClient,
                {
                    event: "action:other",
                    props: {
                        "action:type": "waveconfig:savesecret",
                    },
                },
                { noresponse: true }
            );
            if (generation === this.secretGeneration && revision === this.secretDraftRevision) this.closeSecretView();
        } catch {
            if (generation !== this.secretGeneration) return;
            globalStore.set(this.secretEditorErrorAtom, { key: "settings.secrets.errors.save" });
        } finally {
            if (generation === this.secretGeneration) globalStore.set(this.secretBusyAtom, false);
        }
    }

    async deleteSecret() {
        const selectedSecret = globalStore.get(this.selectedSecretAtom);

        if (!selectedSecret || globalStore.get(this.secretOperationBusyAtom)) return;
        const generation = this.secretGeneration;

        globalStore.set(this.secretBusyAtom, true);
        globalStore.set(this.secretEditorErrorAtom, null);

        try {
            await this.writeSecrets({ [selectedSecret]: null });
            if (generation === this.secretGeneration) this.closeSecretView();
            await this.refreshSecrets();
        } catch {
            if (generation !== this.secretGeneration) return;
            globalStore.set(this.secretEditorErrorAtom, { key: "settings.secrets.errors.delete" });
        } finally {
            if (generation === this.secretGeneration) globalStore.set(this.secretBusyAtom, false);
        }
    }

    startAddingSecret() {
        this.resetSecretEditor();
        globalStore.set(this.isAddingNewAtom, true);
    }

    cancelAddingSecret() {
        this.resetSecretEditor();
    }

    // Closing an editor cannot cancel a dispatched write. Keep later mutations from overtaking it.
    async writeSecrets(updates: Record<string, string>) {
        globalStore.set(this.secretMutationBusyAtom, true);
        try {
            await this.env.rpc.SetSecretsCommand(TabRpcClient, updates);
        } finally {
            globalStore.set(this.secretMutationBusyAtom, false);
        }
    }

    async addNewSecret() {
        if (!globalStore.get(this.secretCanAddAtom)) return;
        const name = globalStore.get(this.newSecretNameAtom).trim();
        const value = globalStore.get(this.newSecretValueAtom);

        if (!name) {
            globalStore.set(this.secretEditorErrorAtom, { key: "settings.secrets.errors.emptyName" });
            return;
        }

        if (!SecretNameRegex.test(name)) {
            globalStore.set(this.secretEditorErrorAtom, { key: "settings.secrets.errors.invalidName" });
            return;
        }

        const existingNames = globalStore.get(this.secretNamesAtom);
        if (existingNames.includes(name)) {
            globalStore.set(this.secretEditorErrorAtom, { key: "settings.secrets.errors.duplicate", vars: { name } });
            return;
        }

        const generation = this.secretGeneration;
        globalStore.set(this.secretBusyAtom, true);
        globalStore.set(this.secretEditorErrorAtom, null);

        try {
            await this.writeSecrets({ [name]: value });
            this.env.rpc.RecordTEventCommand(
                TabRpcClient,
                {
                    event: "action:other",
                    props: {
                        "action:type": "waveconfig:savesecret",
                    },
                },
                { noresponse: true }
            );
            if (generation === this.secretGeneration) this.cancelAddingSecret();
            await this.refreshSecrets();
        } catch {
            if (generation !== this.secretGeneration) return;
            globalStore.set(this.secretEditorErrorAtom, { key: "settings.secrets.errors.add" });
        } finally {
            if (generation === this.secretGeneration) globalStore.set(this.secretBusyAtom, false);
        }
    }

    giveFocus(): boolean {
        const selectedFile = globalStore.get(this.selectedFileAtom);
        if (selectedFile?.isSecrets && this.secretValueRef) {
            this.secretValueRef.focus();
            return true;
        }
        if (this.editorRef?.current) {
            this.editorRef.current.focus();
            return true;
        }
        return false;
    }
}
