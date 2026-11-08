// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Release menu's "How this project ships" (FR-MC-043): the pipeline's technical documentation, the repository
// file in a preview panel or the backend's page in the browser panel. Kept apart from the setup's dialogs, which load
// on their first opening.

import { fireAndForget } from "@/util/util";
import { openFromPanel } from "../app-panel";
import type { PanelOrigin } from "../app-panel-model";
import { useT } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";
import { usePanelOrigin } from "../panel-cta";
import type { SetupTechDocLink } from "./release-setup-model";

// The file opens beside the panel the menu is in, in the same view (#1844, FR-SHELL-139 AC13).
export function openTechDoc(doc: SetupTechDocLink, origin?: PanelOrigin): void {
    if (doc?.path) {
        fireAndForget(() => openFromPanel(origin, { meta: { view: "preview", file: doc.path } }));
        return;
    }
    if (doc?.url) {
        fireAndForget(() => openWebLink(doc.url));
    }
}

export function TechDocLinkButton({ doc, onOpen }: { doc: SetupTechDocLink; onOpen: () => void }) {
    const t = useT();
    const origin = usePanelOrigin();
    if (!doc?.path && !doc?.url) {
        return null;
    }
    return (
        <button
            type="button"
            onClick={(e) => {
                onOpen();
                openTechDoc(doc, origin(e));
            }}
            className="flex cursor-pointer items-center gap-1.5 px-1 text-left text-11 text-accent hover:underline"
            data-testid="release-techdoc-link"
            title={t("mc.setup.techdoc.linkHint")}
        >
            <i className="fa fa-solid fa-book text-11" />
            {t("mc.setup.techdoc.link")}
        </button>
    );
}
