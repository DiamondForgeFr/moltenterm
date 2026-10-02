// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The native file and folder pickers the Moltenterm shell asks emain for (FR-MC-001: linking a workspace to its
// project, choosing its logo). Shared by emain/moltenterm-dialogs.ts and the renderer.

// must match the channel in emain/preload.ts
export const MoltentermChoosePathChannel = "moltenterm-choose-path";

export type MoltentermChoosePathOpts = {
    kind: "folder" | "image";
    title?: string;
    defaultPath?: string;
};

export const MoltentermImageExtensions = ["svg", "png", "ico", "jpg", "jpeg", "webp", "gif"];
