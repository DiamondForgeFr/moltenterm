// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useT } from "../i18n/i18n";
import { ReleaseUpdateModel } from "./release-update-store";

// The status bar's entry for a newer release (#188): it leads to the update itself, in Settings › About, where it is
// accepted; where the app cannot install updates it opens the release page, where the files are.
export function ReleaseUpdateButton() {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const offer = useAtomValue(model.offerAtom, { store: globalStore });
    const plan = useAtomValue(model.planAtom, { store: globalStore });
    useEffect(() => model.start(), []);
    if (offer == null) {
        return null;
    }
    const installs = plan != null && plan.mode !== "none";
    return (
        <button
            type="button"
            data-testid="release-update"
            onClick={() => model.openUpdate(offer)}
            title={t(installs ? "update.release.buttonTitleInstall" : "update.release.buttonTitle", {
                version: offer.version,
            })}
            className="flex cursor-pointer items-center gap-1 rounded-6 border border-accent/60 px-1.5 leading-[16px] text-primary hover:bg-accent/15"
        >
            <i className="fa fa-solid fa-circle-arrow-up text-11 text-accent" />
            {t("update.release.button", { version: offer.version })}
        </button>
    );
}
