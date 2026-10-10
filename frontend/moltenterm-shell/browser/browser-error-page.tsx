// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The error page drawn over a tab's webview when its page fails to load (FR-SHELL-051, DS-SHELL-092).

import { EmptyState } from "../empty-state";
import { errorPageView, LoadError, LoadErrorClass } from "./browser-error";

const Icons: Record<LoadErrorClass, string> = {
    dns: "circle-question",
    refused: "plug-circle-xmark",
    timeout: "hourglass-end",
    tls: "shield-halved",
    offline: "wifi",
    other: "triangle-exclamation",
};

export function BrowserErrorPage({
    error,
    retrying,
    onRetry,
    onStartDevServer,
}: {
    error: LoadError;
    retrying: boolean;
    onRetry: () => void;
    onStartDevServer: () => void;
}) {
    const view = errorPageView(error);
    return (
        <div className="molten-browser-error absolute inset-0 z-[1] bg-surface-1" data-errorclass={view.errorClass}>
            <EmptyState
                icon={Icons[view.errorClass]}
                title={view.title}
                hint={view.hint}
                primary={{ label: "Retry", busyLabel: "Retrying…", busy: retrying, onClick: () => onRetry() }}
                secondary={
                    view.local
                        ? {
                              label: "Start the dev server…",
                              title: "Open a panel next to this one to start it",
                              onClick: () => onStartDevServer(),
                          }
                        : undefined
                }
                details={view.details}
                testId="browser-error-page"
            />
        </div>
    );
}
