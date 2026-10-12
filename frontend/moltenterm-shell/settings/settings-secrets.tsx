// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Settings > Secrets (#534): the secrets of the system's secret store, in the settings' own language, on the calls
// of Wave's settings model (WaveConfigViewModel: list, show, save, delete, add). A value is never shown until the
// user asks for it, nothing here logs a value, and without a proper secret store nothing is offered.

import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { MoltenWave } from "../molten-button";
import { PageCard, PageRowClass } from "./settings-page";

const InputClass =
    "h-row rounded-4 border border-line-strong bg-transparent px-2 text-12 text-primary outline-none placeholder:text-muted focus:border-accent";
const ValueClass =
    "min-h-[96px] w-full rounded-4 border border-line-strong bg-transparent px-2 py-1.5 font-mono text-12 text-primary outline-none placeholder:text-muted focus:border-accent";
const SecondaryButton = "molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:opacity-50";
const PrimaryButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12 font-medium disabled:opacity-50";

function Notice({ text, tone }: { text: string; tone: "error" | "warning" }) {
    return (
        <div
            role="alert"
            className={cn(
                "flex items-center gap-2 rounded-6 border px-3 py-2 text-12",
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
    const name = useAtomValue(model.newSecretNameAtom);
    const value = useAtomValue(model.newSecretValueAtom);
    const setName = useSetAtom(model.newSecretNameAtom);
    const setValue = useSetAtom(model.newSecretValueAtom);
    return (
        <PageCard title="New secret" hint="A letter first, then letters, digits and underscores.">
            <div className="flex flex-col gap-3 px-4 py-3">
                <label className="flex flex-col gap-1 text-12 text-secondary">
                    Name
                    <input
                        autoFocus
                        type="text"
                        value={name}
                        spellCheck={false}
                        placeholder="GITHUB_TOKEN"
                        onChange={(e) => setName(e.target.value)}
                        className={cn(InputClass, "font-mono")}
                        data-testid="secret-new-name"
                    />
                </label>
                <label className="flex flex-col gap-1 text-12 text-secondary">
                    Value
                    <textarea
                        value={value}
                        spellCheck={false}
                        onChange={(e) => setValue(e.target.value)}
                        className={ValueClass}
                    />
                </label>
                <div className="flex justify-end gap-2">
                    <button type="button" className={SecondaryButton} onClick={() => model.cancelAddingSecret()}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        className={PrimaryButton}
                        onClick={() => fireAndForget(() => model.addNewSecret())}
                    >
                        Add secret
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </PageCard>
    );
}

function SecretDetail({ model, name, busy }: { model: WaveConfigViewModel; name: string; busy: boolean }) {
    const value = useAtomValue(model.secretValueAtom);
    const shown = useAtomValue(model.secretShownAtom);
    const setValue = useSetAtom(model.secretValueAtom);
    const [confirmDelete, setConfirmDelete] = useState(false);
    return (
        <PageCard title={name} hint="Saving replaces the stored value.">
            <div className="flex flex-col gap-3 px-4 py-3">
                <textarea
                    ref={(ref) => {
                        model.secretValueRef = ref;
                    }}
                    value={value}
                    spellCheck={false}
                    disabled={busy}
                    placeholder={shown ? "" : "Type a new value"}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            model.closeSecretView();
                        }
                    }}
                    className={ValueClass}
                    data-testid="secret-value"
                />
                {!shown ? (
                    <div className="flex items-center gap-2 text-12 text-muted">
                        <i className="fa fa-solid fa-eye-slash text-11" aria-hidden />
                        The stored value stays hidden until you show it.
                        <button
                            type="button"
                            disabled={busy}
                            className="cursor-pointer text-accent hover:underline"
                            onClick={() => fireAndForget(() => model.showSecret())}
                        >
                            Show value
                        </button>
                    </div>
                ) : null}
                <div className="flex items-center gap-2">
                    {confirmDelete ? (
                        <>
                            <button
                                type="button"
                                disabled={busy}
                                className="molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12 font-medium"
                                onClick={() => fireAndForget(() => model.deleteSecret())}
                            >
                                Delete {name}
                                <MoltenWave />
                            </button>
                            <button type="button" className={SecondaryButton} onClick={() => setConfirmDelete(false)}>
                                Keep it
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            disabled={busy}
                            className="molten-btn-ghost cursor-pointer rounded-6 px-2 py-1.5 text-12 text-danger"
                            onClick={() => setConfirmDelete(true)}
                        >
                            <i className="fa fa-solid fa-trash mr-1.5 text-11" aria-hidden />
                            Delete…
                        </button>
                    )}
                    <span className="flex-1" />
                    <button type="button" className={SecondaryButton} onClick={() => model.closeSecretView()}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        className={PrimaryButton}
                        onClick={() => fireAndForget(() => model.saveSecret())}
                    >
                        Save
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </PageCard>
    );
}

export function SecretsSection({ model }: { model: WaveConfigViewModel }) {
    const names = useAtomValue(model.secretNamesAtom);
    const selected = useAtomValue(model.selectedSecretAtom);
    const busy = useAtomValue(model.isLoadingAtom);
    const error = useAtomValue(model.errorMessageAtom);
    const backendError = useAtomValue(model.storageBackendErrorAtom);
    const adding = useAtomValue(model.isAddingNewAtom);
    const sorted = useMemo(() => [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), [names]);

    useEffect(() => {
        fireAndForget(() => model.checkStorageBackend());
        fireAndForget(() => model.refreshSecrets());
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
                title="Stored secrets"
                hint={sorted.length === 0 ? null : `${sorted.length}`}
                label="Stored secrets"
            >
                {sorted.length === 0 ? (
                    <div className="flex items-center gap-3 px-4 py-4 text-12 text-muted">
                        <i className="fa fa-solid fa-key text-icon-14" aria-hidden />
                        {busy ? "Loading secrets…" : "No secret yet."}
                    </div>
                ) : (
                    sorted.map((name) => (
                        <div key={name} className={cn(PageRowClass, name === selected && "bg-surface-2")}>
                            <i className="fa fa-solid fa-key text-11 text-muted" aria-hidden />
                            <span className="min-w-0 flex-1 truncate font-mono text-12 text-primary">{name}</span>
                            <button
                                type="button"
                                className="molten-btn-ghost cursor-pointer rounded-6 px-2 py-1 text-12"
                                onClick={() => fireAndForget(() => model.viewSecret(name))}
                            >
                                Edit
                            </button>
                        </div>
                    ))
                )}
            </PageCard>
            {!adding ? (
                <div className="pt-4">
                    <button
                        type="button"
                        className={PrimaryButton}
                        onClick={() => model.startAddingSecret()}
                        data-testid="secret-add"
                    >
                        <i className="fa fa-solid fa-plus mr-1.5 text-11" aria-hidden />
                        Add a secret
                        <MoltenWave />
                    </button>
                </div>
            ) : null}
        </div>
    );
}
