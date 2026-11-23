// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The password warning bar of the browser panel (#1980, FR-BRW-023): a password field took the focus on a page served over
// plain http outside the local machine, and the tab warns in the slot of the other bars. It never takes the focus, never
// disables the field and blocks nothing: Understood (or Escape) dismisses it for that page. The address it checks is the
// one the panel reads from the webview, so a page cannot call the warning up for another one.

import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useT } from "../i18n/i18n";
import type { ConnectionModel } from "./connection-store";

export function InsecurePasswordBar({
    connection,
    tabId,
    address,
}: {
    connection: ConnectionModel;
    tabId: string;
    address: string;
}) {
    const t = useT();
    useAtomValue(connection.warningsAtom);
    const shown = connection.warningFor(tabId, address) != null;
    useEffect(() => {
        if (!shown) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                connection.dismissWarning(tabId);
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [connection, tabId, shown]);
    if (!shown) {
        return null;
    }
    return (
        <div
            role="region"
            aria-label={t("browser.connection.password.aria")}
            data-testid="insecure-password-bar"
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                e.stopPropagation();
                connection.dismissWarning(tabId);
            }}
            className="molten-browser-insecure-password flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-2 py-1.5 text-12"
        >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-4 bg-warning/15 text-warning">
                <i className="fa fa-solid fa-lock-open text-11" aria-hidden />
            </span>
            <div aria-live="polite" className="flex min-w-[150px] flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="shrink-0 text-primary">{t("browser.connection.password.title")}</span>
                <span className="min-w-0 text-secondary">{t("browser.connection.password.detail")}</span>
            </div>
            <button
                type="button"
                data-testid="insecure-password-dismiss"
                onClick={() => connection.dismissWarning(tabId)}
                className="h-6 shrink-0 cursor-pointer rounded-4 border border-border px-2.5 text-primary hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)"
            >
                {t("browser.connection.password.dismiss")}
            </button>
        </div>
    );
}
