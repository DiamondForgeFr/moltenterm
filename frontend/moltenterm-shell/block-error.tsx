// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A render error in one panel stays in that panel (#1750): the layout draws each block inside its own boundary, whose
// fallback fills the panel's place with the error, so the rest of the view keeps working.

import { ErrorBoundary } from "@/element/errorboundary";
import { uxCloseBlock } from "@/store/keymodel";
import { ReactNode } from "react";
import { useT } from "./i18n/i18n";

export function BlockErrorFallback({ blockId, error }: { blockId: string; error?: Error }) {
    const t = useT();
    return (
        <div
            className="flex h-full w-full flex-col gap-2 overflow-auto rounded-4 border border-error/40 bg-panel p-4 text-primary"
            data-blockid={blockId}
            data-testid="block-error"
        >
            <div className="text-sm font-semibold">{t("wave.block.errorTitle")}</div>
            <div className="text-xs text-secondary">{t("wave.block.errorBody")}</div>
            {error?.message ? (
                <pre className="text-[11px] whitespace-pre-wrap break-words text-error/90">{error.message}</pre>
            ) : null}
            <div>
                <button
                    type="button"
                    className="cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary"
                    onClick={() => uxCloseBlock(blockId)}
                >
                    {t("wave.block.errorClose")}
                </button>
            </div>
        </div>
    );
}

export function BlockErrorBoundary({ blockId, children }: { blockId: string; children: ReactNode }) {
    return <ErrorBoundary fallback={<BlockErrorFallback blockId={blockId} />}>{children}</ErrorBoundary>;
}
