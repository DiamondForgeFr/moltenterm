// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notes this build was made with (FR-REL-004), inlined by Vite at build time so the history reads offline. The
// second pattern keeps the engineering records out of the app: the glob inlines contents, so a record filtered out at
// run time would still ship. Imported only by the version history, which loads lazily.

import type { MoltentermBuildChange } from "../build/build-info";
import { catalogFromFiles, ReleaseNoteEntry } from "./release-notes-catalog";

const files = import.meta.glob(["/releases/v*.md", "!/releases/*.internal.md"], {
    query: "?raw",
    import: "default",
    eager: true,
}) as unknown as Record<string, string>;

export const BundledReleaseNotes: readonly ReleaseNoteEntry[] = catalogFromFiles(files);

export const BuildChanges: readonly MoltentermBuildChange[] =
    typeof __MOLTENTERM_BUILD_CHANGES__ === "undefined" ? [] : __MOLTENTERM_BUILD_CHANGES__;
