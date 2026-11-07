// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The client certificate questions of a browser panel (#1979, FR-BRW-016). Kept apart from the bar so the panel holds
// the questions without loading the bar's code, which only arrives once a site asks (NFR-PERF-003, bundle.initialJsMB).

import { getApi } from "@/app/store/global";
import { OfferedCertificate } from "./client-certificate";
import { DecisionDismiss } from "./site-permission";
import { TabAsks } from "./tab-asks";

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

export class ClientCertificateModel extends TabAsks<CertificateAsk> {
    answer(requestId: string, decision: string, fingerprint?: string): void {
        this.remove(requestId);
        (getApi() as ClientCertificateApi).moltentermClientCertificateAnswer?.(requestId, decision, fingerprint);
    }

    // A closed tab goes without a certificate this time.
    forgetTab(tabId: string): void {
        for (const ask of this.asksOf(tabId)) {
            this.answer(ask.requestid, DecisionDismiss);
        }
    }
}
