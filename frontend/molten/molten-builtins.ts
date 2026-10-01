// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The mods shipped inside Moltenterm. Their files are bundled as text and go through the same manifest check and
// loading as a user mod, so each one stays an honest example of the public API.

import copyBoxMain from "./builtin/copy-box/main.js?raw";
import copyBoxManifest from "./builtin/copy-box/mod.json?raw";
import type { MoltenBuiltinMod } from "./molten-host";

export const MoltenBuiltinMods: MoltenBuiltinMod[] = [
    { id: "copy-box", files: { "mod.json": copyBoxManifest, "main.js": copyBoxMain } },
];
