// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A site's icon as an image (#1962, DS-SHELL-126): in a view's glyph, in a menu row, in a bookmark's row or dialog. It is
// only ever an <img>: an SVG icon never becomes markup in the page, and a script in one never runs. An icon that fails
// to load shows the generic web icon, never a broken image.

import { cn } from "@/util/util";
import { useEffect, useState } from "react";
import { requestFavicons, useSiteIcons } from "./favicon-store";
import "./favicon.css";
import { originOfAddress } from "./site";
import { faviconGlyphOf } from "./site-glyph";

export function GenericWebMark({ className }: { className?: string }) {
    return <i className={cn("fa fa-solid fa-globe", className)} aria-hidden />;
}

export function FaviconMark({ url, dark, className }: { url: string; dark?: boolean; className?: string }) {
    const [broken, setBroken] = useState<string>(null);
    if (broken === url) {
        return <GenericWebMark className={className} />;
    }
    return (
        <img
            className={cn("mt-favicon", dark && "is-dark", className)}
            src={url}
            alt=""
            draggable={false}
            data-testid="site-favicon"
            onError={() => setBroken(url)}
        />
    );
}

// The icon of the site an address belongs to: its kept icon, else the generic web icon (a site never visited, or one that
// declares none).
export function AddressIcon({ address, className }: { address: string; className?: string }) {
    const origin = originOfAddress(address);
    const icons = useSiteIcons();
    useEffect(() => requestFavicons([origin]), [origin]);
    const glyph = faviconGlyphOf(origin, icons);
    if (glyph == null) {
        return <GenericWebMark className={className} />;
    }
    return <FaviconMark url={glyph.url} dark={glyph.dark} className={className} />;
}
