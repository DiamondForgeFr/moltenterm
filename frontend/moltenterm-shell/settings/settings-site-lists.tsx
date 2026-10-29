// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Browser › the per-site settings as editable lists (FR-SHELL-106): which browser opens a site, what agents may do on
// it, and what it may use (camera, microphone, location, notifications). A site per row, its choice changed in place
// or the site removed; the browser panel's bars add the sites. "Edit in JSON" stays for the rest of the file.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { BrowserEngineModel, EngineApp, EngineInstalled, engineName } from "../browser/browser-engine";
import { DecisionAllow, DecisionBlock, SitePermissionStore } from "../browser/site-permission";
import { writeSettings } from "../command-panel/bindings";
import { useT } from "../i18n/i18n";
import {
    AgentSitesKey,
    SiteDecisions,
    SiteEnginesKey,
    siteKinds,
    SitePermissionsListKey,
    siteRows,
    withoutSite,
    withSiteKind,
    withSiteValue,
} from "./settings-sites";

const SecondaryButton =
    "molten-btn-secondary inline-flex h-row shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 text-12";
const RemoveButton =
    "molten-btn-ghost inline-flex h-row w-row shrink-0 cursor-pointer items-center justify-center rounded-4 text-12";

type ListProps = { entryKey: string; label: string; value: unknown; onOpenJson: () => void };

function useWrite(key: string): [string, (next: unknown) => void] {
    const [errorKey, setErrorKey] = useState<string>(null);
    const write = (next: unknown) => {
        setErrorKey(null);
        fireAndForget(async () => {
            try {
                await writeSettings({ [key]: next ?? null });
            } catch (e) {
                console.error("settings: site list write failed", key, e);
                setErrorKey("settings.error.notSaved");
            }
        });
    };
    return [errorKey, write];
}

function Segmented({
    label,
    value,
    choices,
    onChoose,
}: {
    label: string;
    value: string;
    choices: { value: string; label: string }[];
    onChoose: (v: string) => void;
}) {
    return (
        <div role="radiogroup" aria-label={label} className="flex shrink-0 rounded-4 border border-line-strong p-0.5">
            {choices.map((c) => (
                <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={value === c.value}
                    onClick={() => onChoose(c.value)}
                    className={cn(
                        "cursor-pointer rounded-3 px-2 py-0.5 text-12 transition-colors duration-120 ease-mt",
                        value === c.value ? "bg-surface-2 text-primary" : "text-muted hover:text-primary"
                    )}
                >
                    {c.label}
                </button>
            ))}
        </div>
    );
}

function RemoveSite({ site, onRemove }: { site: string; onRemove: () => void }) {
    const t = useT();
    const label = t("settings.sites.remove", { site });
    return (
        <button type="button" className={RemoveButton} aria-label={label} title={label} onClick={onRemove}>
            <i className="fa fa-solid fa-xmark" aria-hidden />
        </button>
    );
}

function ListFrame({
    label,
    count,
    errorKey,
    onOpenJson,
    children,
}: {
    label: string;
    count: number;
    errorKey: string;
    onOpenJson: () => void;
    children: React.ReactNode;
}) {
    const t = useT();
    return (
        <div className="flex flex-col gap-1 px-5 pb-3" data-site-list>
            {count === 0 ? (
                <div className="text-12 text-muted">{t("settings.sites.empty")}</div>
            ) : (
                <ul aria-label={label} className="flex flex-col divide-y divide-line rounded-4 border border-line">
                    {children}
                </ul>
            )}
            {errorKey ? (
                <div role="alert" className="text-12 text-danger">
                    {t(errorKey)}
                </div>
            ) : null}
            <div>
                <button type="button" className={cn(SecondaryButton, "mt-1")} onClick={onOpenJson}>
                    {t("settings.editInJson")}
                </button>
            </div>
        </div>
    );
}

const RowClass = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5";
const SiteClass = "min-w-0 flex-1 basis-40 truncate font-mono text-12 text-primary";

function EngineSites({ entryKey, label, value, onOpenJson }: ListProps) {
    const t = useT();
    const list = useAtomValue(BrowserEngineModel.getInstance().listAtom, { store: globalStore });
    useEffect(() => {
        fireAndForget(() => BrowserEngineModel.getInstance().ensureLoaded());
    }, []);
    const [errorKey, write] = useWrite(entryKey);
    const map = value as Record<string, string>;
    const rows = siteRows<string>(value);
    const engines = [EngineApp, EngineInstalled, ...(list?.browsers ?? []).map((b) => b.id)].filter(
        (id, i, all) => all.indexOf(id) === i
    );
    return (
        <ListFrame label={label} count={rows.length} errorKey={errorKey} onOpenJson={onOpenJson}>
            {rows.map(({ site, value: engine }) => {
                const current = (engine ?? "").trim().toLowerCase();
                const options = engines.includes(current) || current === "" ? engines : [current, ...engines];
                return (
                    <li key={site} className={RowClass} data-site={site}>
                        <span className={SiteClass} title={site}>
                            {site}
                        </span>
                        <select
                            aria-label={t("settings.sites.engineFor", { site })}
                            value={current}
                            onChange={(e) => write(withSiteValue(map, site, e.target.value))}
                            className="h-row max-w-48 min-w-0 cursor-pointer rounded-4 border border-line-strong bg-surface-2 px-2 pr-1 text-12 text-primary outline-none focus:border-accent"
                        >
                            {options.map((id) => (
                                <option key={id} value={id}>
                                    {engineName(id, list)}
                                </option>
                            ))}
                        </select>
                        <RemoveSite site={site} onRemove={() => write(withoutSite(map, site))} />
                    </li>
                );
            })}
        </ListFrame>
    );
}

function AgentSites({ entryKey, label, value, onOpenJson }: ListProps) {
    const t = useT();
    const [errorKey, write] = useWrite(entryKey);
    const map = value as Record<string, string>;
    const rows = siteRows<string>(value);
    const choices = SiteDecisions.map((d) => ({ value: d, label: t(`settings.sites.decision.${d}`) }));
    return (
        <ListFrame label={label} count={rows.length} errorKey={errorKey} onOpenJson={onOpenJson}>
            {rows.map(({ site, value: decision }) => (
                <li key={site} className={RowClass} data-site={site}>
                    <span className={SiteClass} title={site}>
                        {site}
                    </span>
                    <Segmented
                        label={t("settings.sites.agentsOn", { site })}
                        value={(decision ?? "").trim().toLowerCase()}
                        choices={choices}
                        onChoose={(d) => write(withSiteValue(map, site, d))}
                    />
                    <RemoveSite site={site} onRemove={() => write(withoutSite(map, site))} />
                </li>
            ))}
        </ListFrame>
    );
}

function PermissionSites({ entryKey, label, value, onOpenJson }: ListProps) {
    const t = useT();
    const [errorKey, write] = useWrite(entryKey);
    const store = value as SitePermissionStore;
    const rows = siteRows<Record<string, string>>(value);
    const choices = [DecisionAllow, DecisionBlock].map((d) => ({ value: d, label: t(`settings.sites.decision.${d}`) }));
    return (
        <ListFrame label={label} count={rows.length} errorKey={errorKey} onOpenJson={onOpenJson}>
            {rows.map(({ site, value: decisions }) => (
                <li key={site} className="flex flex-col gap-1 px-3 py-1.5" data-site={site}>
                    <div className="flex min-w-0 items-center gap-3">
                        <span className={SiteClass} title={site}>
                            {site}
                        </span>
                        <RemoveSite site={site} onRemove={() => write(withoutSite(store, site))} />
                    </div>
                    {siteKinds(decisions).map((kind) => {
                        const kindLabel = t(`settings.sites.kind.${kind}`);
                        return (
                            <div key={kind} className="flex min-w-0 items-center gap-3 pl-3" data-kind={kind}>
                                <span className="min-w-0 flex-1 truncate text-12 text-secondary">{kindLabel}</span>
                                <Segmented
                                    label={t("settings.sites.kindOn", { what: kindLabel, site })}
                                    value={(decisions[kind] ?? "").trim().toLowerCase()}
                                    choices={choices}
                                    onChoose={(d) => write(withSiteKind(store, site, kind, d))}
                                />
                                <button
                                    type="button"
                                    className={RemoveButton}
                                    aria-label={t("settings.sites.forget", { what: kindLabel, site })}
                                    title={t("settings.sites.forget", { what: kindLabel, site })}
                                    onClick={() => write(withSiteKind(store, site, kind, null))}
                                >
                                    <i className="fa fa-solid fa-rotate-left text-11" aria-hidden />
                                </button>
                            </div>
                        );
                    })}
                </li>
            ))}
        </ListFrame>
    );
}

// The list under a per-site row of Browser, or null for any other key.
export function SiteList(props: ListProps) {
    switch (props.entryKey) {
        case SiteEnginesKey:
            return <EngineSites {...props} />;
        case AgentSitesKey:
            return <AgentSites {...props} />;
        case SitePermissionsListKey:
            return <PermissionSites {...props} />;
        default:
            return null;
    }
}
