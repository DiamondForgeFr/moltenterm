// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How a companion panel's chips read a pasted image (FR-SHELL-018, #2455): the host (companion-tips.tsx) provides it
// to the popover of a chip and to the dialog that shows the image full size.

import { createContext, useContext, useEffect, useState } from "react";
import type { CompanionImage } from "./companion-tips-model";

export type ImageAccess = {
    // The image numbered n of the session, read once and kept for a while: null when it cannot be found.
    load: (n: number, at: number) => Promise<CompanionImage>;
};

export const ImageAccessContext = createContext<ImageAccess>(null);

export function useCompanionImage(): ImageAccess {
    return useContext(ImageAccessContext);
}

// The size in pixels of the image a chip shows, known once the browser loaded it. It is kept with the image it belongs
// to, so that a later image never shows the size of an earlier one.
export function useImagePixels(image: CompanionImage): [[number, number], (pixels: [number, number]) => void] {
    const [measured, setMeasured] = useState<{ image: CompanionImage; pixels: [number, number] }>(null);
    return [
        measured != null && measured.image === image ? measured.pixels : null,
        (pixels) => setMeasured({ image, pixels }),
    ];
}

// The image of a chip: undefined while it is being read, null when it cannot be found.
export function useChipImage(n: number, at: number): CompanionImage {
    const access = useCompanionImage();
    const [image, setImage] = useState<CompanionImage>(undefined);
    useEffect(() => {
        let cancelled = false;
        setImage(undefined);
        if (access == null) {
            setImage(null);
            return;
        }
        access.load(n, at).then(
            (loaded) => !cancelled && setImage(loaded ?? null),
            () => !cancelled && setImage(null)
        );
        return () => {
            cancelled = true;
        };
    }, [access, n, at]);
    return image;
}
