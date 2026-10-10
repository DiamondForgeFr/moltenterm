// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The project icon offer (FR-SHELL-059, DS-SHELL-101): once a workspace is linked to a project that has a real image,
// a toast with that image's thumbnail offers it as the workspace icon, with Use this icon and Dismiss. A project
// without an image offers nothing, and nothing ever opens a dialog unasked (#410: the old dialog covered the window
// right after the link and swallowed the clicks on the new Project tab).

import { getWebServerEndpoint } from "@/util/endpoints";
import { fireAndForget } from "@/util/util";
import { ToastInput } from "./toast-model";
import { dismissToast, showToast } from "./toast-store";
import { logoUrl, pathBaseName } from "./workspace-project";
import { findProjectLogos, markLogoOffered, readProjectFacts, setWorkspaceLogo } from "./workspace-project-store";

export const IconOfferToastPrefix = "project-icon-offer:";

export type IconOfferInput = {
    workspaceId: string;
    workspaceName: string;
    dir: string;
    projectName: string;
    // The project's images, best first (findProjectLogos): only files that exist, never a generated fallback.
    logos: string[];
    thumbnailUrl: (path: string) => string;
};

export function iconOfferToastId(workspaceId: string): string {
    return IconOfferToastPrefix + workspaceId;
}

// The toast to show, or null when the project has no image. The answer is remembered for the project (#77); a toast
// that leaves by itself, unanswered, comes back in a later session.
export function makeIconOffer(input: IconOfferInput): ToastInput {
    const logo = input.logos?.[0];
    if (!logo) {
        return null;
    }
    const id = iconOfferToastId(input.workspaceId);
    const answer = async (use: boolean) => {
        if (use) {
            await setWorkspaceLogo(input.workspaceId, logo);
        }
        await markLogoOffered(input.workspaceId, input.dir);
        dismissToast(id);
    };
    const name = input.projectName || pathBaseName(input.dir);
    return {
        id,
        kind: "info",
        title: `Use ${name}'s logo?`,
        message: input.workspaceName ? `As the icon of ${input.workspaceName}` : "As this workspace's icon",
        thumbnail: input.thumbnailUrl(logo),
        actions: [
            { id: "use", label: "Use this icon", run: () => answer(true) },
            { id: "dismiss", label: "Dismiss", run: () => answer(false) },
        ],
        onDismiss: (reason) => {
            if (reason === "user") {
                fireAndForget(() => markLogoOffered(input.workspaceId, input.dir));
            }
        },
    };
}

// Looks for the project's images and shows the offer when there is one; the toast's id, or "" when nothing is offered.
export async function offerProjectIcon(ws: Workspace, dir: string): Promise<string> {
    const [logos, facts] = await Promise.all([findProjectLogos(dir), readProjectFacts(dir)]);
    const toast = makeIconOffer({
        workspaceId: ws.oid,
        workspaceName: ws.name ?? "",
        dir,
        projectName: facts?.name ?? "",
        logos,
        thumbnailUrl: (path) => logoUrl(getWebServerEndpoint(), path),
    });
    return toast == null ? "" : showToast(toast);
}
