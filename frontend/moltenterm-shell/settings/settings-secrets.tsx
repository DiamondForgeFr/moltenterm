// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Settings > Secrets (#534): the secrets of the system's secret store, in the settings' own language, on the calls
// of Wave's settings model (WaveConfigViewModel: list, show, save, delete, add). A value is never shown until the
// user asks for it, nothing here logs a value, and without a proper secret store nothing is offered.

import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { suiteIcon } from "../suite/suite-icons";
import { PageCard, PageRowClass } from "./settings-page";

const InputClass =
    "h-row rounded-4 border border-line-strong bg-transparent px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";
const ValueClass =
    "min-h-[96px] w-full rounded-4 border border-line-strong bg-transparent px-2 py-1.5 font-mono text-12 text-primary outline-none placeholder:text-muted focus:border-accent";
const SecondaryButton = "molten-btn-secondary cursor-pointer rounded-4 px-3 py-1.5 text-12 disabled:opacity-50";
const PrimaryButton = "molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12 font-medium disabled:opacity-50";

function Notice({ text, tone }: { text: string; tone: "error" | "warning" }) {
    return (
        <div
            role="alert"
            className={cn(
                "flex items-center gap-2 rounded-4 border px-3 py-2 text-12",
                tone === "error" ? "border-error/40 text-danger" : "border-warning/40 text-warning"
            )}
        >
            <i
                className={cn(
                    "fa fa-solid text-icon-14",
                    tone === "error" ? "fa-circle-exclamation" : "fa-triangle-exclamation"
                )}
                aria-hidden
            />
            <span>{text}</span>
        </div>
    );
}

function AddSecret({ model, busy }: { model: WaveConfigViewModel; busy: boolean }) {
    const t = useT();
    const name = useAtomValue(model.newSecretNameAtom);
    const value = useAtomValue(model.newSecretValueAtom);
    const setName = useSetAtom(model.newSecretNameAtom);
    const setValue = useSetAtom(model.newSecretValueAtom);
    const canAdd = useAtomValue(model.secretCanAddAtom);
    return (
        <PageCard
            title={t("settings.secrets.new.title")}
            icon={suiteIcon("secrets")}
            hint={t("settings.secrets.new.hint")}
            scope="app"
        >
            <div
                className="flex flex-col gap-3 px-5 py-3"
                onKeyDown={(event) => {
                    if (event.key === "Escape") model.cancelAddingSecret();
                }}
            >
                <label className="flex flex-col gap-1 text-12 text-secondary">
                    {t("settings.secrets.name")}
                    <input
                        autoFocus
                        type="text"
                        value={name}
                        spellCheck={false}
                        disabled={busy}
                        placeholder="GITHUB_TOKEN"
                        onChange={(e) => setName(e.target.value)}
                        className={cn(InputClass, "font-mono")}
                        data-testid="secret-new-name"
                    />
                </label>
                <label className="flex flex-col gap-1 text-12 text-secondary">
                    {t("settings.secrets.value")}
                    <textarea
                        value={value}
                        spellCheck={false}
                        disabled={busy}
                        onChange={(e) => setValue(e.target.value)}
                        className={ValueClass}
                    />
                </label>
                <div className="flex justify-end gap-2">
                    <button type="button" className={SecondaryButton} onClick={() => model.cancelAddingSecret()}>
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        disabled={!canAdd}
                        className={PrimaryButton}
                        onClick={() => fireAndForget(() => model.addNewSecret())}
                    >
                        {t("settings.secrets.new.add")}
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </PageCard>
    );
}

function SecretDetail({ model, name, busy }: { model: WaveConfigViewModel; name: string; busy: boolean }) {
    const t = useT();
    const value = useAtomValue(model.secretValueAtom);
    const shown = useAtomValue(model.secretShownAtom);
    const edited = useAtomValue(model.secretEditedAtom);
    const canSave = useAtomValue(model.secretCanSaveAtom);
    const [confirmDelete, setConfirmDelete] = useState(false);
    return (
        <PageCard
            title={name}
            titleCase="as-is"
            icon={suiteIcon("secrets")}
            hint={t("settings.secrets.detail.hint")}
            scope="app"
        >
            <div
                className="flex flex-col gap-3 px-5 py-3"
                onKeyDown={(event) => {
                    if (event.key === "Escape") model.closeSecretView();
                }}
            >
                <textarea
                    ref={(ref) => {
                        model.secretValueRef = ref;
                    }}
                    value={value}
                    spellCheck={false}
                    disabled={busy}
                    placeholder={shown ? "" : t("settings.secrets.detail.placeholder")}
                    onChange={(e) => model.editSecretValue(e.target.value)}
                    className={ValueClass}
                    data-testid="secret-value"
                />
                {!shown ? (
                    <div className="flex items-center gap-2 text-12 text-muted">
                        <i className="fa fa-solid fa-eye-slash text-11" aria-hidden />
                        {t("settings.secrets.detail.hidden")}
                        <button
                            type="button"
                            disabled={busy || edited}
                            className="cursor-pointer text-accent hover:underline"
                            onClick={() => fireAndForget(() => model.showSecret())}
                        >
                            {t("settings.secrets.detail.show")}
                        </button>
                    </div>
                ) : null}
                <div className="flex items-center gap-2">
                    {confirmDelete ? (
                        <>
                            <button
                                type="button"
                                disabled={busy}
                                className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-3 py-1.5 text-12 font-medium"
                                onClick={() => fireAndForget(() => model.deleteSecret())}
                            >
                                {t("settings.secrets.detail.deleteName", { name })}
                                <MoltenWave />
                            </button>
                            <button type="button" className={SecondaryButton} onClick={() => setConfirmDelete(false)}>
                                {t("settings.secrets.detail.keep")}
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            disabled={busy}
                            className="molten-btn-ghost cursor-pointer rounded-4 px-2 py-1.5 text-12 text-danger"
                            onClick={() => setConfirmDelete(true)}
                        >
                            <i className="fa fa-solid fa-trash mr-1.5 text-11" aria-hidden />
                            {t("settings.secrets.detail.delete")}
                        </button>
                    )}
                    <span className="flex-1" />
                    <button type="button" className={SecondaryButton} onClick={() => model.closeSecretView()}>
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        disabled={!canSave}
                        className={PrimaryButton}
                        onClick={() => fireAndForget(() => model.saveSecret())}
                    >
                        {t("common.save")}
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </PageCard>
    );
}

export function SecretsSection({ model }: { model: WaveConfigViewModel }) {
    const t = useT();
    const names = useAtomValue(model.secretNamesAtom);
    const selected = useAtomValue(model.selectedSecretAtom);
    const busy = useAtomValue(model.secretOperationBusyAtom);
    const loading = useAtomValue(model.secretsLoadingAtom);
    const namesReady = useAtomValue(model.secretNamesReadyAtom);
    const error = useAtomValue(model.secretErrorAtom);
    const backendError = useAtomValue(model.storageBackendErrorAtom);
    const adding = useAtomValue(model.isAddingNewAtom);
    const sorted = useMemo(() => [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), [names]);

    useEffect(() => {
        fireAndForget(() => model.checkStorageBackend());
        fireAndForget(() => model.refreshSecrets());
        return () => model.closeSecretView();
    }, [model]);

    if (backendError) {
        return (
            <div className="pt-6">
                <Notice text={backendError} tone="warning" />
            </div>
        );
    }
    return (
        <div className="flex flex-col" data-testid="settings-secrets">
            {error ? (
                <div className="pt-4">
                    <Notice text={error} tone="error" />
                </div>
            ) : null}
            {adding ? <AddSecret model={model} busy={busy} /> : null}
            {selected ? <SecretDetail key={selected} model={model} name={selected} busy={busy} /> : null}
            <PageCard
                title={t("settings.secrets.stored")}
                hint={sorted.length === 0 ? null : `${sorted.length}`}
                label={t("settings.secrets.stored")}
                icon={suiteIcon("secrets")}
                scope="app"
                footer={
                    !adding ? (
                        <button
                            type="button"
                            disabled={!namesReady || loading}
                            className={PrimaryButton}
                            onClick={() => model.startAddingSecret()}
                            data-testid="secret-add"
                        >
                            <i className="fa fa-solid fa-plus mr-1.5 text-11" aria-hidden />
                            {t("settings.secrets.addOne")}
                            <MoltenWave />
                        </button>
                    ) : null
                }
            >
                {sorted.length === 0 ? (
                    <div className="flex items-center gap-3 px-5 py-4 text-12 text-muted">
                        <i className="fa fa-solid fa-key text-icon-14" aria-hidden />
                        {loading ? t("settings.secrets.loading") : t("settings.secrets.none")}
                    </div>
                ) : (
                    sorted.map((name) => (
                        <div key={name} className={cn(PageRowClass, name === selected && "bg-surface-2")}>
                            <i className="fa fa-solid fa-key text-11 text-muted" aria-hidden />
                            <span className="min-w-0 flex-1 truncate font-mono text-12 text-primary">{name}</span>
                            <button
                                type="button"
                                className="molten-btn-ghost cursor-pointer rounded-4 px-2 py-1 text-12"
                                onClick={() => fireAndForget(() => model.viewSecret(name))}
                            >
                                {t("settings.secrets.edit")}
                            </button>
                        </div>
                    ))
                )}
            </PageCard>
        </div>
    );
}
