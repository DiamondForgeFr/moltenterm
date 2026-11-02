// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useId, useLayoutEffect, useRef } from "react";
import { DialogFrameClass } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { pathBaseName } from "../workspace-project";
import { FileConfineGate, FileConfinePending, pendingFolder } from "./file-confine";

export function fileConfineQuestion(
    t: (key: string, vars?: Record<string, any>) => string,
    pending: FileConfinePending
) {
    const folder = pendingFolder(pending);
    const path = pending.resolved || pending.target;
    const where = pending.isDir
        ? t("fileConfine.folderOutside", { folder, project: pending.projectName })
        : t("fileConfine.fileOutside", { file: pathBaseName(path), folder, project: pending.projectName });
    let who = "";
    if (pending.origin.kind === "agent") {
        who = t("fileConfine.agentAsked", { name: pending.origin.name });
    } else if (pending.origin.kind === "command") {
        who = t("fileConfine.commandAsked");
    }
    return { where, who };
}

// The question stays inside the panel (not a window-wide dialog): the rest of the window keeps working while it waits.
export function FileConfineConfirm({ gate }: { gate: FileConfineGate }) {
    const t = useT();
    const pending = useAtomValue(gate.pendingAtom);
    const stayRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const target = pending?.target;
    useLayoutEffect(() => {
        if (target != null) {
            stayRef.current?.focus();
        }
    }, [target]);
    if (pending == null) {
        return null;
    }
    const { where, who } = fileConfineQuestion(t, pending);
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key !== "Escape") {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        fireAndForget(() => gate.stay());
    };
    return (
        <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-[color-mix(in_srgb,var(--mt-surface-0,#000)_70%,transparent)] p-4"
            data-testid="file-confine-confirm"
        >
            <div
                role="alertdialog"
                aria-labelledby={titleId}
                className={cn(DialogFrameClass, "flex max-w-[420px] flex-col gap-2 p-4 text-12 text-primary")}
                onKeyDown={onKeyDown}
            >
                <div id={titleId} className="text-13 font-semibold">
                    {t("fileConfine.title")}
                </div>
                <p className="break-all text-secondary">{where}</p>
                {who && <p className="text-secondary">{who}</p>}
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button
                        ref={stayRef}
                        type="button"
                        className="cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                        onClick={() => fireAndForget(() => gate.stay())}
                    >
                        {t("fileConfine.stay")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                        onClick={() => fireAndForget(() => gate.openOutside())}
                    >
                        {t("fileConfine.open")}
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </div>
    );
}
