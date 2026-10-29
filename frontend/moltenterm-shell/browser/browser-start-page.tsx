// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's start page (FR-SHELL-111): drawn over a browser panel whose repository page has no repository to show,
// a project without a GitHub remote or a workspace without a project. It shows the project's README when its folder
// has one, otherwise what the view is for.

import { Markdown } from "@/app/element/markdown";
import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { EmptyState } from "../empty-state";
import { useT } from "../i18n/i18n";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { readReadme } from "../workspace-project-store";

type ReadmeState = { dir: string; text: string };

export function BrowserStartPage() {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const dir = readWorkspaceProject(ws).dir;
    const [readme, setReadme] = useState<ReadmeState>(null);
    useEffect(() => {
        if (!dir) {
            return;
        }
        let live = true;
        readReadme(dir).then((text) => {
            if (live) {
                setReadme({ dir, text: text ?? "" });
            }
        });
        return () => {
            live = false;
        };
    }, [dir]);
    const loaded = !dir || readme?.dir === dir;
    const text = dir && readme?.dir === dir ? readme.text : "";
    return (
        <div className="molten-browser-start absolute inset-0 z-[1] flex flex-col bg-surface-1" data-testid="browser-start-page">
            {!loaded ? null : text ? (
                <>
                    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-11 text-muted">
                        <i className="fa fa-solid fa-book-open text-11" />
                        <span className="truncate">{t("browser.start.readme", { project: pathBaseName(dir) })}</span>
                    </div>
                    <Markdown
                        text={text}
                        className="min-h-0 flex-1"
                        contentClassName="px-4 py-3"
                        resolveOpts={{ connName: "local", baseDir: dir }}
                    />
                </>
            ) : (
                <EmptyState
                    icon="compass-drafting"
                    title={t("browser.start.title")}
                    hint={dir ? t("browser.start.hintProject") : t("browser.start.hintNoProject")}
                    testId="browser-start-empty"
                />
            )}
        </div>
    );
}
