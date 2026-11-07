// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A remote image in markdown or in an AI answer (#2045, FR-BRW-014). The app page's Content-Security-Policy loads no
// image from a web address (emain/moltenterm-app-csp.ts): an image request is a way out for anything injected into the
// page, and it tells the image's host that the file was opened. So the image is never fetched: it shows as a link with
// its description and its site, and a click opens it in the browser panel, as a markdown link does.

import { openLink } from "@/app/store/global";
import { siteNameOf } from "./favicon/site";
import { useT } from "./i18n/i18n";

export function isRemoteImage(src: unknown): boolean {
    return typeof src === "string" && /^https?:/i.test(src.trim());
}

export function RemoteImageLink({ src, alt }: { src: string; alt?: string }) {
    const t = useT();
    const site = siteNameOf(src) || src;
    const label = alt?.trim() ? alt.trim() : t("wave.markdown.remoteImage", { site });
    return (
        <a
            href={src}
            onClick={(e) => {
                e.preventDefault();
                void openLink(src);
            }}
            title={t("wave.markdown.remoteImageTitle", { address: src })}
            data-testid="remote-image-link"
            className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-4 border border-border px-1.5 py-0.5 align-middle text-accent hover:underline"
        >
            <i className="fa fa-solid fa-image shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
            {alt?.trim() ? <span className="shrink-0 text-muted">{site}</span> : null}
        </a>
    );
}
