// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace's icon: the project's logo when the user chose one (FR-MC-001), otherwise its Font Awesome icon. The
// Font Awesome icon stays set on the workspace: Wave needs it, and it comes back when the image cannot be shown.

import { getWebServerEndpoint } from "@/util/endpoints";
import { cn, makeIconClass } from "@/util/util";
import { useState } from "react";
import { logoUrl } from "./workspace-project";

export function WorkspaceIcon({
    icon,
    color,
    logo,
    className,
}: {
    icon: string;
    color?: string;
    logo?: string;
    className?: string;
}) {
    const [failedLogo, setFailedLogo] = useState<string>(null);
    if (logo && logo !== failedLogo) {
        return (
            <img
                src={logoUrl(getWebServerEndpoint(), logo)}
                alt=""
                draggable={false}
                onError={() => setFailedLogo(logo)}
                className={cn("inline-block h-[1.1em] w-[1.1em] rounded-[2px] object-contain", className)}
            />
        );
    }
    return <i className={cn(makeIconClass(icon, false), className)} style={{ color }} />;
}
