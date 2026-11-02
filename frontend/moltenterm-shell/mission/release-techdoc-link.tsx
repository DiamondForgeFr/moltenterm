// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Release menu's "How this project ships" (FR-MC-043): the pipeline's technical documentation, the repository
// file in a preview panel or the backend's page in the browser panel. Kept apart from the setup's dialogs, which load
// on their first opening.

import { createBlock } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { useT } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";
import type { SetupTechDocLink } from "./release-setup-model";

export function openTechDoc(doc: SetupTechDocLink): void {
    if (doc?.path) {
        fireAndForget(() => createBlock({ meta: { view: "preview", file: doc.path } }));
        return;
    }
    if (doc?.url) {
        fireAndForget(() => openWebLink(doc.url));
    }
}

export function TechDocLinkButton({ doc, onOpen }: { doc: SetupTechDocLink; onOpen: () => void }) {
    const t = useT();
    if (!doc?.path && !doc?.url) {
        return null;
    }
    return (
        <button
            type="button"
            onClick={() => {
                onOpen();
                openTechDoc(doc);
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
