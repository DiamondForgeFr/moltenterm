// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Web links of the terminal (#2507): plain URLs (WebLinksAddon) and OSC 8 hyperlinks, which agents print for their
// Markdown links, go through the same callbacks. Without a `linkHandler`, xterm.js activates an OSC 8 link with a
// native window.confirm, which blocks the whole window: this handler replaces it.

import { PlatformMacOS } from "@/util/platformutil";

const AllowedSchemes = ["http:", "https:"];

export type TermLinkTarget = {
    platform: string;
    open: (uri: string) => void;
    hover: (uri: string, mouseX: number, mouseY: number) => void;
    leave: () => void;
};

export type TermLinkCallbacks = {
    activate: (e: MouseEvent, uri: string) => void;
    hover: (e: MouseEvent, uri: string) => void;
    leave: () => void;
    // xterm.js already drops non-http(s) OSC 8 links when this is false; the scheme check below stays as a second guard.
    allowNonHttpProtocols: boolean;
};

// Same set as the plain links WebLinksAddon matches, so a hidden OSC 8 target cannot reach the OS handler with a
// scheme (file:, ssh:, a custom app scheme) a visible URL could not.
export function isAllowedTermLinkUri(uri: string): boolean {
    if (uri == null || uri === "") {
        return false;
    }
    try {
        return AllowedSchemes.includes(new URL(uri).protocol);
    } catch {
        return false;
    }
}

export function isTermLinkModifierPressed(e: MouseEvent, platform: string): boolean {
    if (platform === PlatformMacOS) {
        return e.metaKey;
    }
    return e.ctrlKey;
}

export function makeTermLinkCallbacks(target: TermLinkTarget): TermLinkCallbacks {
    return {
        activate: (e, uri) => {
            e.preventDefault();
            if (!isTermLinkModifierPressed(e, target.platform)) {
                return;
            }
            if (!isAllowedTermLinkUri(uri)) {
                return;
            }
            target.open(uri);
        },
        hover: (e, uri) => {
            if (!isAllowedTermLinkUri(uri)) {
                return;
            }
            target.hover(uri, e.clientX, e.clientY);
        },
        leave: () => target.leave(),
        allowNonHttpProtocols: false,
    };
}
