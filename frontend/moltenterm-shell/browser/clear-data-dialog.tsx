// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The confirmations of "Clear this site's data…" and "Clear the browser cache…" (FR-BRW-022 AC7, AC8): each says what
// goes and what stays before anything is removed; Cancel and Escape remove nothing.

import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { ClearCacheKind, ClearSiteKind } from "./site-data";

export type ClearDataRequest =
    | { kind: typeof ClearSiteKind; tabId: string; origin: string; host: string }
    | { kind: typeof ClearCacheKind; tabId: string };

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";
// Calm and red-bordered, without the molten wave: only molten actions carry it (#1318, decision 9).
const DangerButton =
    "cursor-pointer rounded-6 border border-error/60 px-3 py-1.5 text-12 text-danger hover:border-error hover:bg-error/10";

export function ClearDataDialog({
    request,
    onCancel,
    onConfirm,
}: {
    request: ClearDataRequest;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const t = useT();
    const site = request.kind === ClearSiteKind ? request : null;
    return (
        <DialogFrame
            role="browser-clear-data"
            title={t(site != null ? "browser.siteData.siteTitle" : "browser.siteData.cacheTitle")}
            subtitle={site?.origin}
            onEscape={onCancel}
            buttons={
                <>
                    <button type="button" className={PlainButton} onClick={onCancel} data-testid="clear-data-cancel">
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={DangerButton}
                        onClick={onConfirm}
                        autoFocus
                        data-testid="clear-data-confirm"
                    >
                        {t(site != null ? "browser.siteData.siteConfirm" : "browser.siteData.cacheConfirm")}
                    </button>
                </>
            }
        >
            {site != null ? (
                <>
                    <p>{t("browser.siteData.siteIntro", { origin: site.origin })}</p>
                    <ul className="list-disc pl-5 text-secondary" data-testid="clear-data-list">
                        <li>{t("browser.siteData.siteCookies", { host: site.host })}</li>
                        <li>{t("browser.siteData.siteStorage")}</li>
                        <li>{t("browser.siteData.siteCache")}</li>
                    </ul>
                    <p className="text-secondary">{t("browser.siteData.siteKept")}</p>
                </>
            ) : (
                <>
                    <p>{t("browser.siteData.cacheBody")}</p>
                    <p className="text-secondary">{t("browser.siteData.cacheKept")}</p>
                </>
            )}
        </DialogFrame>
    );
}
