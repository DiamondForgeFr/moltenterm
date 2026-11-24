// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The question asked when a folder chosen for a workspace lies outside its context's folder (#2518, FR-SHELL-158): it
// never blocks, one answer keeps the folder and the panels of the workspace may then leave the context's. Escape keeps
// nothing and asks nothing more.

import { DialogFrame } from "./dialog-frame";
import { useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

export function FolderOutsideDialog({
    contextName,
    contextFolder,
    onUse,
    onChooseAnother,
    onCancel,
}: {
    contextName: string;
    contextFolder: string;
    onUse: () => void;
    onChooseAnother: () => void;
    onCancel: () => void;
}) {
    const t = useT();
    return (
        <DialogFrame
            role="workspace-folder-outside"
            title={t("workspace.project.outsideContextTitle", { name: contextName })}
            onEscape={onCancel}
            buttons={
                <>
                    <button
                        type="button"
                        className={PlainButton}
                        data-testid="folder-outside-another"
                        onClick={onChooseAnother}
                        autoFocus
                    >
                        {t("workspace.project.chooseAnother")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                        data-testid="folder-outside-use"
                        onClick={onUse}
                    >
                        {t("workspace.project.useFolder")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <p className="text-secondary">{t("workspace.project.outsideContextBody")}</p>
            <p className="mt-1 break-all font-mono text-11 text-primary" title={contextFolder}>
                {contextFolder}
            </p>
        </DialogFrame>
    );
}
