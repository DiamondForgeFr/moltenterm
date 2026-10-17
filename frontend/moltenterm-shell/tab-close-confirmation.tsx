// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useRef } from "react";
import { DialogFrame } from "./dialog-frame";
import { useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";

export function TabCloseConfirmation({ onAnswer }: { onAnswer: (confirmed: boolean) => void }) {
    const t = useT();
    const cancelRef = useRef<HTMLButtonElement>(null);
    const answerRef = useRef(onAnswer);
    answerRef.current = onAnswer;
    useLayoutEffect(() => {
        cancelRef.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            const ownDialog = cancelRef.current?.closest('[role="dialog"]');
            const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
            if (event.key !== "Escape" || ownDialog == null || dialogs[dialogs.length - 1] !== ownDialog) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            answerRef.current(false);
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return (
        // Portal events still bubble through React's tab row: cancellation must never select, rename or close it.
        <span
            className="contents"
            onClick={stop}
            onDoubleClick={stop}
            onMouseDown={stop}
            onMouseUp={stop}
            onPointerDown={stop}
            onPointerUp={stop}
            onAuxClick={stop}
            onContextMenu={stop}
            onKeyDown={stop}
            onKeyUp={stop}
        >
            <DialogFrame
                role="molten-semantic-tab-close"
                title={t("dialog.closeTab.button")}
                trapFocus
                onBackdrop={() => onAnswer(false)}
                buttons={
                    <>
                        <button
                            ref={cancelRef}
                            type="button"
                            className="cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                            onClick={() => onAnswer(false)}
                        >
                            {t("common.cancel")}
                        </button>
                        <button
                            type="button"
                            className="molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12"
                            onClick={() => onAnswer(true)}
                        >
                            {t("dialog.closeTab.button")}
                            <MoltenWave />
                        </button>
                    </>
                }
            >
                <p>{t("dialog.closeTab.message")}</p>
            </DialogFrame>
        </span>
    );
}
