// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A pasted image at its full size (FR-SHELL-018, #2455): what a click on an image's chip opens, in the shell's dialog.
// The image is the one the popover read, kept by the companion's host. Loaded when a chip is first clicked.

import { DialogFrame } from "../dialog-frame";
import { formatSize } from "../downloads/downloads-format";
import { useT } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { useChipImage, useImagePixels } from "./companion-image-access";
import { imageBytes, imageSource } from "./companion-tips-model";

const CloseButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

export function ImageDialog({ n, at, onClose }: { n: number; at: number; onClose: () => void }) {
    const t = useT();
    // undefined while it is being read, null when it cannot be found.
    const image = useChipImage(n, at);
    const [pixels, setPixels] = useImagePixels(image);
    const bytes = image == null ? "" : formatSize(imageBytes(image));
    const subtitle =
        image == null
            ? undefined
            : pixels != null
              ? t("companion.image.size", { width: pixels[0], height: pixels[1], bytes })
              : bytes;
    return (
        <DialogFrame
            role="companion-image"
            title={t("companion.image.title", { n })}
            subtitle={subtitle}
            widthClass="w-fit min-w-[360px]"
            onEscape={onClose}
            onBackdrop={onClose}
            buttons={
                <button type="button" className={CloseButton} onClick={onClose} autoFocus>
                    {t("common.close")}
                </button>
            }
        >
            {image === undefined ? (
                <div className="text-muted" data-testid="companion-image-full-loading">
                    <DominoLoader className="mr-1.5" />
                    {t("common.loading")}
                </div>
            ) : image === null ? (
                <div className="text-muted" data-testid="companion-image-full-unavailable">
                    {t("companion.image.unavailable")}
                </div>
            ) : (
                <img
                    src={imageSource(image)}
                    alt={t("companion.image.alt", { n })}
                    className="block max-w-none self-start"
                    data-testid="companion-image-full"
                    onLoad={(e) => setPixels([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
                />
            )}
        </DialogFrame>
    );
}
