// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useT } from "../i18n/i18n";
import { openReleasePage, ReleaseUpdateModel } from "./release-update-store";

// The status bar's entry for a newer release (#188): it opens the release page, where the files are.
export function ReleaseUpdateButton() {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const offer = useAtomValue(model.offerAtom, { store: globalStore });
    useEffect(() => model.start(), []);
    if (offer == null) {
        return null;
    }
    return (
        <button
            type="button"
            data-testid="release-update"
            onClick={() => openReleasePage(offer.url)}
            title={t("update.release.buttonTitle", { version: offer.version })}
            className="flex cursor-pointer items-center gap-1 rounded-6 border border-accent/60 px-1.5 leading-[16px] text-primary hover:bg-accent/15"
        >
            <i className="fa fa-solid fa-circle-arrow-up text-11 text-accent" />
            {t("update.release.button", { version: offer.version })}
        </button>
    );
}
