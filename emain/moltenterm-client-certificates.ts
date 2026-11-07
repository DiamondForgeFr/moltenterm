// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Client certificates for every session (#1979, FR-BRW-016). Without a handler Electron presents the first certificate
// of the system store to any site that asks for one, which tells the site who the user is without a word. This handler
// stops that: a page gets a certificate only when the user picked it for that site in the tab (a page that opened in a
// popup asks in its opener's tab), and the choice is remembered in browser:clientcertificates, which only a window and
// this process write (pkg/wshrpc/wshserver/moltenterm_configguard.go). A page no panel shows (a Wave web block) uses only
// a remembered choice. MoltenTerm's own renderers, and a request that comes from no page, get no certificate.
//
// The question travels like the site permission bar's (emain/moltenterm-site-permissions.ts): main sends it to the
// renderer holding the tab's webview, whose preload hands it to the webview element; the panel's bar answers.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { randomUUID } from "crypto";
import * as electron from "electron";
import {
    CertificateAnswer,
    CertificateUse,
    ClientCertificateStore,
    ClientCertificatesKey,
    OfferedCertificate,
    clientCertificateSite,
    clientCertificateStoreOf,
    offeredCertificates,
    rememberedCertificate,
    validCertificateAnswer,
    withCertificateChoice,
} from "../frontend/moltenterm-shell/browser/client-certificate";
import { DecisionDismiss } from "../frontend/moltenterm-shell/browser/site-permission";
import { ElectronWshClient } from "./emain-wsh";
import { onAppIpc } from "./moltenterm-privileged-ipc";
import { isAppRenderer, panelGuestOf } from "./moltenterm-site-permissions";
import { liveWebContentsFromId } from "./moltenterm-webcontents-id";

// main -> the renderer holding the webview: (requestId, guestWebContentsId, site, certificates)
export const ClientCertificateAskChannel = "moltenterm-client-certificate-ask";
// renderer -> main: (requestId, decision, fingerprint)
export const ClientCertificateAnswerChannel = "moltenterm-client-certificate-answer";
// main -> the renderer: (requestId), the question is gone (answered elsewhere, timed out, page closed or moved on)
export const ClientCertificateDoneChannel = "moltenterm-client-certificate-done";

// A question nobody answers goes without a certificate this time, so the page's request settles.
const AskTimeoutMs = 5 * 60 * 1000;

type PendingAsk = {
    key: string;
    hostId: number;
    guest: electron.WebContents;
    site: string;
    offered: OfferedCertificate[];
    answers: ((answer: CertificateAnswer) => void)[];
    timer: ReturnType<typeof setTimeout>;
    onNavigate: (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void;
    onDestroyed: () => void;
};

let store: ClientCertificateStore = {};
const pending = new Map<string, PendingAsk>();
const pendingByKey = new Map<string, string>();
let installed = false;

export function noteClientCertificateSettings(settings: Record<string, unknown>): void {
    store = clientCertificateStoreOf(settings?.[ClientCertificatesKey]);
}

function persist(next: ClientCertificateStore): void {
    store = next;
    RpcApi.SetConfigCommand(ElectronWshClient, { [ClientCertificatesKey]: next } as SettingsType).catch((e) =>
        console.log("client certificates: not saved", e)
    );
}

function finish(requestId: string, answer: CertificateAnswer): void {
    const ask = pending.get(requestId);
    if (ask == null) {
        return;
    }
    pending.delete(requestId);
    pendingByKey.delete(ask.key);
    clearTimeout(ask.timer);
    ask.guest.off("did-start-navigation", ask.onNavigate);
    ask.guest.off("destroyed", ask.onDestroyed);
    if (answer.decision !== DecisionDismiss) {
        persist(withCertificateChoice(store, ask.site, answer));
    }
    const host = liveWebContentsFromId(ask.hostId);
    if (host != null) {
        host.send(ClientCertificateDoneChannel, requestId);
    }
    for (const resolve of ask.answers) {
        resolve(answer);
    }
}

function ask(guest: electron.WebContents, site: string, offered: OfferedCertificate[]): Promise<CertificateAnswer> {
    const host = guest.hostWebContents;
    if (host == null || host.isDestroyed()) {
        return Promise.resolve({ decision: DecisionDismiss });
    }
    const key = `${guest.id}|${site}|${offered
        .map((c) => c.fingerprint)
        .sort()
        .join(",")}`;
    return new Promise((resolve) => {
        const existing = pendingByKey.get(key);
        if (existing != null && pending.has(existing)) {
            pending.get(existing).answers.push(resolve);
            return;
        }
        const requestId = randomUUID();
        // The request that raised the question dies with its navigation: a question left behind would be stale.
        const onNavigate = (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
            if (details?.isMainFrame && !details.isSameDocument) {
                finish(requestId, { decision: DecisionDismiss });
            }
        };
        const onDestroyed = () => finish(requestId, { decision: DecisionDismiss });
        pending.set(requestId, {
            key,
            hostId: host.id,
            guest,
            site,
            offered,
            answers: [resolve],
            timer: setTimeout(() => finish(requestId, { decision: DecisionDismiss }), AskTimeoutMs),
            onNavigate,
            onDestroyed,
        });
        pendingByKey.set(key, requestId);
        guest.on("did-start-navigation", onNavigate);
        guest.once("destroyed", onDestroyed);
        host.send(ClientCertificateAskChannel, requestId, guest.id, site, offered);
    });
}

// The certificate to present, or null for none.
export async function chooseClientCertificate(
    wc: electron.WebContents | null,
    requested: string,
    list: electron.Certificate[]
): Promise<electron.Certificate | null> {
    if (wc == null || wc.isDestroyed() || isAppRenderer(wc)) {
        return null;
    }
    const site = clientCertificateSite(requested);
    const offered = offeredCertificates(list);
    const remembered = rememberedCertificate(store, site, offered);
    let fingerprint: string = null;
    if (remembered.verdict === "use") {
        fingerprint = remembered.fingerprint;
    } else if (remembered.verdict === "ask") {
        const guest = panelGuestOf(wc);
        if (guest == null || guest.isDestroyed()) {
            return null;
        }
        const answer = await ask(guest, site, offered);
        fingerprint = answer.decision === CertificateUse ? answer.fingerprint : null;
    }
    if (fingerprint == null) {
        return null;
    }
    return list.find((c) => c?.fingerprint === fingerprint) ?? null;
}

function onSelectClientCertificate(
    event: electron.Event,
    wc: electron.WebContents | null,
    requested: string,
    list: electron.Certificate[],
    callback: (certificate?: electron.Certificate) => void
): void {
    // Synchronously, or Electron has already taken the first certificate.
    event.preventDefault();
    chooseClientCertificate(wc, requested, list).then(
        (certificate) => (certificate != null ? callback(certificate) : callback()),
        (e) => {
            console.log("client certificate error", e);
            callback();
        }
    );
}

export function initMoltentermClientCertificates(fullConfig: FullConfigType): void {
    noteClientCertificateSettings(fullConfig?.settings as Record<string, unknown>);
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            const settings = (event?.data as { fullconfig?: FullConfigType })?.fullconfig?.settings;
            if (settings != null) {
                noteClientCertificateSettings(settings as Record<string, unknown>);
            }
        },
    });
}

// Before any window, like the permission handlers.
export function installMoltentermClientCertificateHandler(): void {
    if (installed) {
        return;
    }
    installed = true;
    electron.app.on("select-client-certificate", onSelectClientCertificate);
    onAppIpc(ClientCertificateAnswerChannel, (event, requestId: unknown, decision: unknown, fingerprint: unknown) => {
        if (typeof requestId !== "string") {
            return;
        }
        const ask = pending.get(requestId);
        if (ask == null || ask.hostId !== event.sender.id) {
            return;
        }
        finish(requestId, validCertificateAnswer(decision, fingerprint, ask.offered));
    });
}
