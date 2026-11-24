// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hover preview of a terminal link (#2507): an OSC 8 link shows a label, so the preview names where it goes.

import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { useT } from "../i18n/i18n";

const MaxShownUriLength = 300;

export function shownLinkUri(uri: string): string {
    if (uri == null || uri.length <= MaxShownUriLength) {
        return uri;
    }
    return uri.slice(0, MaxShownUriLength - 1) + "…";
}

export function TermLinkTooltipContent({ uri }: { uri: string }) {
    const t = useT();
    const mod = PLATFORM === PlatformMacOS ? "Cmd" : "Ctrl";
    return (
        <span className="flex max-w-[480px] flex-col gap-0.5">
            {uri ? <span className="break-all text-primary">{shownLinkUri(uri)}</span> : null}
            <span>{t("wave.term.linkHint", { mod })}</span>
        </span>
    );
}
