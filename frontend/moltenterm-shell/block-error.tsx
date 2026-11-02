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
            className="flex h-full w-full flex-col gap-2 overflow-auto rounded-6 border border-line-strong bg-surface-1 p-4"
            data-blockid={blockId}
            data-testid="block-error"
        >
            <div className="text-13 font-semibold text-primary">{t("wave.block.errorTitle")}</div>
            <div className="text-12 text-secondary">{t("wave.block.errorBody")}</div>
            {error?.message ? (
                <pre className="font-mono text-11 whitespace-pre-wrap break-words text-danger">{error.message}</pre>
            ) : null}
            <div>
                <button
                    type="button"
                    className="molten-btn-secondary cursor-pointer rounded-4 px-3 py-1.5 text-12"
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
