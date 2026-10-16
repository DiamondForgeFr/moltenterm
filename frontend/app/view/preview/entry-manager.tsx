// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/app/element/button";
import { Input } from "@/app/element/input";
import React, { memo, useState } from "react";
import { useT } from "../../../moltenterm-shell/i18n/i18n"; // MOLTENTERM-PATCH (#742)

export enum EntryManagerType {
    NewFile = "New File",
    NewDirectory = "New Folder",
    EditName = "Rename",
}

// MOLTENTERM-PATCH (#742): the overlay's title through i18n keys
const EntryManagerTitleKeys: Record<EntryManagerType, string> = {
    [EntryManagerType.NewFile]: "wave.files.newFile",
    [EntryManagerType.NewDirectory]: "wave.files.newFolder",
    [EntryManagerType.EditName]: "wave.files.rename",
};

export type EntryManagerOverlayProps = {
    forwardRef?: React.Ref<HTMLDivElement>;
    entryManagerType: EntryManagerType;
    startingValue?: string;
    onSave: (newValue: string) => void;
    onCancel?: () => void;
    style?: React.CSSProperties;
    getReferenceProps?: () => any;
};

export const EntryManagerOverlay = memo(
    ({
        entryManagerType,
        startingValue,
        onSave,
        onCancel,
        forwardRef,
        style,
        getReferenceProps,
    }: EntryManagerOverlayProps) => {
        const [value, setValue] = useState(startingValue);
        const t = useT(); // MOLTENTERM-PATCH (#742)
        return (
            <div className="entry-manager-overlay" ref={forwardRef} style={style} {...(getReferenceProps?.() ?? {})}>
                <div className="entry-manager-type">{t(EntryManagerTitleKeys[entryManagerType])}</div>
                <div className="entry-manager-input">
                    <Input
                        value={value}
                        onChange={setValue}
                        autoFocus={true}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                e.stopPropagation();
                                onSave(value);
                            }
                        }}
                    />
                </div>
                <div className="entry-manager-buttons">
                    <Button className="py-[4px]" onClick={() => onSave(value)}>
                        {t("wave.files.save")}
                    </Button>
                    <Button className="py-[4px] red outlined" onClick={onCancel}>
                        {t("wave.files.cancel")}
                    </Button>
                </div>
            </div>
        );
    }
);

EntryManagerOverlay.displayName = "EntryManagerOverlay";
