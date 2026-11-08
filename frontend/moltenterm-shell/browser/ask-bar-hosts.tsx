// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { useAtomValue } from "jotai";
import { lazy, Suspense } from "react";
import { ClientCertificateModel } from "./client-certificate-store";
import { SitePermissionModel } from "./site-permission-store";

// Loaded on demand: these bars only show once a page asks (a site permission, a client certificate), so their code
// stays out of the JS every tab view loads up front (NFR-PERF-003, bundle.initialJsMB). Their click guard starts when
// they mount, after the load.
const SitePermissionBar = lazy(() => import("./site-permission-bar").then((m) => ({ default: m.SitePermissionBar })));
const ClientCertificateBar = lazy(() =>
    import("./client-certificate-bar").then((m) => ({ default: m.ClientCertificateBar }))
);

export function SitePermissionHost({ permissions, tabId }: { permissions: SitePermissionModel; tabId: string }) {
    const asks = useAtomValue(permissions.asksAtom);
    if (!(asks[tabId]?.length > 0)) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <SitePermissionBar permissions={permissions} tabId={tabId} />
        </Suspense>
    );
}

export function ClientCertificateHost({
    certificates,
    tabId,
}: {
    certificates: ClientCertificateModel;
    tabId: string;
}) {
    const asks = useAtomValue(certificates.asksAtom);
    if (!(asks[tabId]?.length > 0)) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <ClientCertificateBar certificates={certificates} tabId={tabId} />
        </Suspense>
    );
}
