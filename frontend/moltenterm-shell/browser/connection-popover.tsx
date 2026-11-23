// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The site information popover under the row (#1980, FR-BRW-023), opened by the connection button: the page's host, how
// it is served in a sentence, the certificate Chromium verified (issued for, issued by, expiry), the permissions the
// developer granted or blocked for the site with a Retire button, and Clear this site's cookies and data. Escape closes it
// and gives the focus back to the button. It reads what main reported and the settings; it asks nothing of the page.

import { getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { getLocale, useT } from "../i18n/i18n";
import { MenuPopover } from "../mission/menu-popover";
import type { CertificateSummary, ConnectionState } from "./connection-security";
import {
    connectionGlyph,
    ConnectionView,
    connectionWordKey,
    ViewInsecure,
    ViewMixed,
    ViewSecure,
} from "./connection-store";
import {
    DecisionAllow,
    permissionSite,
    siteDecisions,
    SitePermissionsKey,
    SitePermissionStore,
    withoutDecision,
} from "./site-permission";

const ViewDetailKeys: Record<ConnectionView["kind"], string> = {
    [ViewSecure]: "browser.connection.popover.secureDetail",
    [ViewInsecure]: "browser.connection.popover.insecureDetail",
    [ViewMixed]: "browser.connection.popover.mixedDetail",
};

const ViewToneClasses: Record<ConnectionView["kind"], string> = {
    [ViewSecure]: "text-muted",
    [ViewInsecure]: "text-warning",
    [ViewMixed]: "text-warning",
};

function hostOf(address: string): string {
    try {
        return new URL(address).host;
    } catch {
        return address ?? "";
    }
}

function expiryText(t: ReturnType<typeof useT>, certificate: CertificateSummary): string {
    if (!(certificate?.validUntil > 0)) {
        return "";
    }
    const date = new Date(certificate.validUntil * 1000).toLocaleDateString(getLocale(), { dateStyle: "long" });
    return t("browser.connection.popover.expires", { date });
}

function Row({ label, value }: { label: string; value: string }) {
    if (value === "") {
        return null;
    }
    return (
        <div className="flex min-w-0 gap-2">
            <dt className="w-[5.5rem] shrink-0 text-muted">{label}</dt>
            <dd className="min-w-0 text-secondary [overflow-wrap:anywhere]">{value}</dd>
        </div>
    );
}

function forgetDecision(store: SitePermissionStore, site: string, kind: string): void {
    const next = withoutDecision(store, site, kind);
    fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { [SitePermissionsKey]: next } as SettingsType));
}

type InfoProps = {
    view: ConnectionView;
    address: string;
    state: ConnectionState | null;
    onClearData?: () => void;
    onClose: () => void;
};

export function ConnectionPopover({ anchor, ...info }: InfoProps & { anchor: Element }) {
    const t = useT();
    return (
        <MenuPopover
            anchor={anchor}
            onClose={info.onClose}
            className="flex flex-col"
            role="dialog"
            ariaLabel={t("browser.connection.popover.aria")}
            focusManaged
        >
            <ConnectionInfo {...info} />
        </MenuPopover>
    );
}

export function ConnectionInfo({ view, address, state, onClearData, onClose }: InfoProps) {
    const t = useT();
    const store = useAtomValue(getSettingsKeyAtom(SitePermissionsKey)) as SitePermissionStore;
    const site = permissionSite(address);
    const certificate = view.kind === ViewSecure || view.kind === ViewMixed ? (state?.certificate ?? null) : null;
    const showsCertificate = view.kind === ViewSecure || view.kind === ViewMixed;
    const decisions = site == null ? [] : siteDecisions(store, site);
    return (
        <div className="flex w-[22rem] max-w-full flex-col gap-3 text-12" data-testid="browser-connection-popover">
            <header className="flex flex-col gap-1.5">
                <div
                    className="font-mono text-13 text-primary [overflow-wrap:anywhere]"
                    data-testid="browser-connection-host"
                >
                    {hostOf(address)}
                </div>
                <div className="flex items-start gap-2">
                    <i
                        className={cn(
                            "fa fa-solid mt-0.5 w-3.5 shrink-0 text-center text-12",
                            connectionGlyph(view.kind),
                            ViewToneClasses[view.kind]
                        )}
                        aria-hidden
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="font-semibold text-primary">
                            {t(view.kind === ViewSecure ? "browser.connection.secure" : connectionWordKey(view.kind))}
                        </div>
                        <p className="leading-4 text-secondary">{t(ViewDetailKeys[view.kind])}</p>
                    </div>
                </div>
            </header>
            {showsCertificate ? (
                <section
                    className="flex flex-col gap-1.5 border-t border-border pt-3"
                    data-testid="browser-connection-certificate"
                >
                    <div className="flex items-center gap-2">
                        <i
                            className={cn(
                                "fa fa-solid w-3.5 shrink-0 text-center text-12",
                                certificate != null
                                    ? "fa-circle-check text-[var(--mt-state-ready)]"
                                    : "fa-certificate text-muted"
                            )}
                            aria-hidden
                        />
                        <h4
                            className="font-semibold text-primary"
                            title={
                                certificate?.fingerprint
                                    ? `${t("browser.connection.popover.fingerprint")}: ${certificate.fingerprint}`
                                    : undefined
                            }
                        >
                            {certificate != null
                                ? t("browser.connection.popover.certificate")
                                : t("browser.connection.popover.certificateNone")}
                        </h4>
                    </div>
                    {certificate != null ? (
                        <dl className="flex flex-col gap-0.5 pl-[22px]">
                            <Row label={t("browser.connection.popover.issuedFor")} value={certificate.subject} />
                            <Row label={t("browser.connection.popover.issuedBy")} value={certificate.issuer} />
                            {expiryText(t, certificate) !== "" ? (
                                <div className="text-secondary">{expiryText(t, certificate)}</div>
                            ) : null}
                        </dl>
                    ) : (
                        <p className="pl-[22px] leading-4 text-muted">
                            {t("browser.connection.popover.certificateUnavailable")}
                        </p>
                    )}
                </section>
            ) : null}
            {site != null ? (
                <section
                    className="flex flex-col gap-1.5 border-t border-border pt-3"
                    data-testid="browser-connection-permissions"
                >
                    <h4 className="text-11 font-semibold text-muted">{t("browser.connection.popover.permissions")}</h4>
                    <ul className="flex flex-col gap-0.5">
                        {decisions.map(({ kind, decision }) => (
                            <li
                                key={kind}
                                className="flex h-6 items-center gap-2"
                                data-testid={`browser-connection-permission-${kind}`}
                            >
                                <span className="min-w-0 flex-1 truncate text-secondary">
                                    {t(`browser.connection.popover.kind.${kind}`)}
                                </span>
                                <span className={cn("shrink-0", decision === "" ? "text-muted" : "text-primary")}>
                                    {decision === ""
                                        ? t("browser.connection.popover.ask")
                                        : decision === DecisionAllow
                                          ? t("browser.connection.popover.allowed")
                                          : t("browser.connection.popover.blocked")}
                                </span>
                                {decision !== "" ? (
                                    <button
                                        type="button"
                                        aria-label={t("browser.connection.popover.removeAria", {
                                            kind: t(`browser.connection.popover.kind.${kind}`),
                                        })}
                                        data-testid={`browser-connection-remove-${kind}`}
                                        onClick={() => forgetDecision(store, site, kind)}
                                        className="h-5 shrink-0 cursor-pointer rounded-4 border border-border px-1.5 text-11 text-secondary hover:bg-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--mt-focus-ring)"
                                    >
                                        {t("browser.connection.popover.remove")}
                                    </button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            {onClearData != null ? (
                <div className="border-t border-border pt-2">
                    <button
                        type="button"
                        data-testid="browser-connection-clear"
                        onClick={() => {
                            onClose();
                            onClearData();
                        }}
                        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-4 px-1.5 text-left text-12 text-secondary hover:bg-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--mt-focus-ring)"
                    >
                        <i
                            className="fa fa-solid fa-eraser w-3.5 shrink-0 text-center text-12 text-muted"
                            aria-hidden
                        />
                        {t("browser.connection.popover.clearData")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
