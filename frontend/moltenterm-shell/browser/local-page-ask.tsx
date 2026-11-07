// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The question a tab asks before it loads a local or inline page a terminal or an agent opened (FR-BRW-014, #1978).
// It is drawn in the page area, never in a native dialog. It takes no focus and has no default button: a key typed
// in the terminal that opened the page must not be able to answer it.

import { Button } from "@/app/element/button";
import { EmptyState } from "../empty-state";
import { useT } from "../i18n/i18n";
import type { BrowserTab } from "./browser-model";
import {
    canRememberLocalPage,
    displayLocalText,
    LocalData,
    localPageOf,
    needsLocalAsk,
    type LocalPages,
} from "./local-page";

export type LocalPageAskModel = {
    allowLocalPage: (id: string) => void;
    rememberLocalPage: (id: string) => void;
    declineLocalPage: (id: string) => void;
};

// A tab's page area: its webview, or, while the tab holds a local or inline page nobody allowed, the question
// instead. The webview is not rendered at all, so the page is never requested before the answer.
export function GatedPage({
    model,
    tab,
    active,
    remembered,
    children,
}: {
    model: LocalPageAskModel;
    tab: BrowserTab;
    active: boolean;
    remembered: LocalPages;
    children: React.ReactNode;
}) {
    if (!needsLocalAsk(tab, remembered)) {
        return <>{children}</>;
    }
    return active ? <LocalPageAsk model={model} tab={tab} /> : null;
}

export function LocalPageAsk({ model, tab }: { model: LocalPageAskModel; tab: BrowserTab }) {
    const t = useT();
    const page = localPageOf(tab.url);
    if (page == null) {
        return null;
    }
    const isData = page.kind === LocalData;
    const title = t(isData ? "browser.local.dataTitle" : "browser.local.fileTitle");
    return (
        <div
            role="group"
            aria-label={title}
            data-testid="browser-local-ask"
            data-kind={page.kind}
            className="molten-browser-local absolute inset-0 z-[1] overflow-auto bg-surface-1"
        >
            <EmptyState
                icon="shield-halved"
                title={title}
                hint={t(isData ? "browser.local.dataHint" : "browser.local.fileHint")}
                primary={{
                    label: t("browser.local.open"),
                    onClick: () => model.allowLocalPage(tab.id),
                    testId: "browser-local-open",
                }}
                secondary={
                    canRememberLocalPage(page)
                        ? {
                              label: t("browser.local.always"),
                              title: t("browser.local.alwaysTitle"),
                              onClick: () => model.rememberLocalPage(tab.id),
                              testId: "browser-local-always",
                          }
                        : undefined
                }
            >
                <div className="mt-1 w-full text-left">
                    {isData ? (
                        <>
                            <div className="text-11 text-muted">
                                {t("browser.local.dataKind", {
                                    type: displayLocalText(page.mediaType, 60),
                                    length: String(page.length),
                                })}
                            </div>
                            {page.start !== "" ? (
                                <>
                                    <div className="mt-1 text-11 text-muted">{t("browser.local.dataStart")}</div>
                                    <pre
                                        data-testid="browser-local-target"
                                        className="mt-0.5 max-h-24 overflow-auto rounded-4 border border-line bg-surface-2 p-2 font-mono text-11 leading-4 break-words whitespace-pre-wrap text-secondary select-text"
                                    >
                                        {displayLocalText(page.start, 200)}
                                    </pre>
                                </>
                            ) : null}
                        </>
                    ) : (
                        <code
                            data-testid="browser-local-target"
                            className="block rounded-4 border border-line bg-surface-2 p-2 font-mono text-11 leading-4 break-all text-primary select-text"
                        >
                            {displayLocalText(page.path)}
                        </code>
                    )}
                </div>
                <Button
                    className="ghost grey !h-7 !px-3 !text-12"
                    title={t("browser.local.declineTitle")}
                    onClick={() => model.declineLocalPage(tab.id)}
                    data-testid="browser-local-decline"
                >
                    {t("browser.local.decline")}
                </Button>
            </EmptyState>
        </div>
    );
}
