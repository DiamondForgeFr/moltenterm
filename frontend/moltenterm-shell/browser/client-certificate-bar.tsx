// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The client certificate bar of the browser panel (#1979, FR-BRW-016): a site asks for a certificate that identifies the
// user, and the tab asks in the slot of the other bars. The certificates of the system are listed with none preselected;
// Use this certificate stays off until one is picked, and Continue without a certificate sends none. Both are remembered
// for the site (browser:clientcertificates); Escape answers for this time only. Like the site permission bar, it never
// takes the focus on its own, and a click right after it appears is ignored, so a click meant for the page cannot answer
// it. The question is a surface of the window, outside the page: nothing a page or an agent drives can reach it.

import { Button } from "@/app/element/button";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { getLocale, useT } from "../i18n/i18n";
import { suiteIcon } from "../suite/suite-icons";
import { answerTooSoon } from "./browser-agent";
import { CertificateNone, CertificateUse, OfferedCertificate } from "./client-certificate";
import { DecisionDismiss } from "./site-permission";

export type CertificateAsk = { requestid: string; site: string; certificates: OfferedCertificate[] };

type ClientCertificateApi = {
    moltentermClientCertificateAnswer?: (requestId: string, decision: string, fingerprint?: string) => void;
};

function isOffered(value: any): value is OfferedCertificate {
    return (
        value != null &&
        typeof value.fingerprint === "string" &&
        typeof value.name === "string" &&
        typeof value.issuer === "string" &&
        typeof value.expires === "number"
    );
}

export function isCertificateAsk(value: any): value is CertificateAsk {
    return (
        value != null &&
        typeof value.requestid === "string" &&
        typeof value.site === "string" &&
        Array.isArray(value.certificates) &&
        value.certificates.every(isOffered)
    );
}

// The questions of one panel, per browser tab, oldest first; in memory only.
export class ClientCertificateModel {
    asksAtom = atom({}) as PrimitiveAtom<Record<string, CertificateAsk[]>>;

    add(tabId: string, ask: CertificateAsk): void {
        const all = globalStore.get(this.asksAtom);
        const list = all[tabId] ?? [];
        if (list.some((a) => a.requestid === ask.requestid)) {
            return;
        }
        globalStore.set(this.asksAtom, { ...all, [tabId]: [...list, ask] });
    }

    // The question is gone: answered here, or settled by main (the timeout, the page closed or moved on).
    remove(requestId: string): void {
        const all = globalStore.get(this.asksAtom);
        let changed = false;
        const next: Record<string, CertificateAsk[]> = {};
        for (const [tabId, list] of Object.entries(all)) {
            const kept = list.filter((a) => a.requestid !== requestId);
            changed = changed || kept.length !== list.length;
            if (kept.length > 0) {
                next[tabId] = kept;
            }
        }
        if (changed) {
            globalStore.set(this.asksAtom, next);
        }
    }

    current(tabId: string): CertificateAsk {
        return globalStore.get(this.asksAtom)[tabId]?.[0] ?? null;
    }

    answer(requestId: string, decision: string, fingerprint?: string): void {
        this.remove(requestId);
        (getApi() as ClientCertificateApi).moltentermClientCertificateAnswer?.(requestId, decision, fingerprint);
    }

    // A closed tab goes without a certificate this time.
    forgetTab(tabId: string): void {
        for (const ask of globalStore.get(this.asksAtom)[tabId] ?? []) {
            this.answer(ask.requestid, DecisionDismiss);
        }
    }
}

function expiryText(t: ReturnType<typeof useT>, expires: number): string {
    if (!(expires > 0)) {
        return "";
    }
    const date = new Date(expires).toLocaleDateString(getLocale(), { dateStyle: "medium" });
    return t("browser.clientCertificate.expires", { date });
}

function CertificateRow({
    cert,
    picked,
    name,
    onPick,
}: {
    cert: OfferedCertificate;
    picked: boolean;
    name: string;
    onPick: () => void;
}) {
    const t = useT();
    const detail = [
        cert.issuer ? t("browser.clientCertificate.issuedBy", { issuer: cert.issuer }) : "",
        expiryText(t, cert.expires),
    ]
        .filter((part) => part !== "")
        .join(" · ");
    return (
        <label
            className={cn(
                "flex cursor-pointer items-start gap-2 rounded-4 border px-2 py-1 hover:bg-hover",
                picked ? "border-accent bg-accent/10" : "border-border"
            )}
        >
            <input
                type="radio"
                name={name}
                value={cert.fingerprint}
                checked={picked}
                onChange={onPick}
                data-testid="client-certificate-option"
                className="mt-0.5 shrink-0 cursor-pointer accent-accent"
            />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-primary">{cert.name || t("browser.clientCertificate.unnamed")}</span>
                {detail !== "" ? <span className="truncate text-secondary">{detail}</span> : null}
            </span>
        </label>
    );
}

function CertificateAskBar({ model, ask }: { model: ClientCertificateModel; ask: CertificateAsk }) {
    const t = useT();
    const [picked, setPicked] = useState("");
    const shownAt = useRef(Date.now());
    const click = (decision: string, fingerprint?: string) => {
        if (answerTooSoon(shownAt.current, Date.now())) {
            return;
        }
        model.answer(ask.requestid, decision, fingerprint);
    };
    const Icon = suiteIcon("identity");
    const group = `client-certificate-${ask.requestid}`;
    return (
        <div
            role="region"
            aria-label={t("browser.clientCertificate.aria")}
            data-testid="client-certificate-bar"
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                e.stopPropagation();
                model.answer(ask.requestid, DecisionDismiss);
            }}
            className="molten-browser-clientcertificate flex shrink-0 flex-col gap-1.5 border-b border-border px-2 py-1.5 text-12"
        >
            <div className="flex items-center gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-4 bg-accent/15 text-accent">
                    <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden={true} />
                </span>
                <div aria-live="polite" className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                    <span className="max-w-full shrink-0 truncate text-primary">
                        {t("browser.clientCertificate.title", { site: ask.site })}
                    </span>
                    <span className="min-w-0 text-secondary">{t("browser.clientCertificate.detail")}</span>
                </div>
            </div>
            <div
                role="radiogroup"
                aria-label={t("browser.clientCertificate.listAria", { site: ask.site })}
                className="flex max-h-36 flex-col gap-1 overflow-y-auto"
            >
                {ask.certificates.map((cert) => (
                    <CertificateRow
                        key={cert.fingerprint}
                        cert={cert}
                        picked={picked === cert.fingerprint}
                        name={group}
                        onPick={() => setPicked(cert.fingerprint)}
                    />
                ))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                    type="button"
                    data-testid="client-certificate-without"
                    onClick={() => click(CertificateNone)}
                    className="h-6 cursor-pointer rounded-4 border border-border px-2.5 text-primary hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)"
                >
                    {t("browser.clientCertificate.without")}
                </button>
                <Button
                    className="!h-6 !px-2.5 !text-12"
                    data-testid="client-certificate-use"
                    disabled={picked === ""}
                    onClick={() => click(CertificateUse, picked)}
                >
                    {t("browser.clientCertificate.use")}
                </Button>
            </div>
        </div>
    );
}

export function ClientCertificateBar({ certificates, tabId }: { certificates: ClientCertificateModel; tabId: string }) {
    const asks = useAtomValue(certificates.asksAtom);
    const ask = asks[tabId]?.[0] ?? null;
    if (ask == null) {
        return null;
    }
    return <CertificateAskBar key={ask.requestid} model={certificates} ask={ask} />;
}
