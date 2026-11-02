// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A project's code repository (FR-SHELL-105, #1777): the Git repository inside its folder that agents start in and the
// Git features read. The folder holds the context (a client's documents, mails, specs); this chooses among the
// repositories found inside it, or none. Shared by the Project sheet and the sidebar's project page.

import { fireAndForget } from "@/util/util";
import { useEffect, useId, useState } from "react";
import { useT } from "./i18n/i18n";
import { missionRepos } from "./mission/mission-client";
import { projectRepoOf, repositoryLabel, repositoryValues } from "./workspace-project";

export type FolderRepositories = {
    // The repositories found inside the folder; null until they are read.
    repos: string[];
    // The folder is itself a repository: nothing to choose.
    self: boolean;
};

export function useFolderRepositories(dir: string): FolderRepositories {
    const [found, setFound] = useState<FolderRepositories & { dir: string }>(null);
    useEffect(() => {
        if (!dir) {
            return;
        }
        let live = true;
        fireAndForget(async () => {
            try {
                const answer = await missionRepos(dir);
                if (live) {
                    setFound({ dir, repos: answer?.repos ?? [], self: answer?.self === true });
                }
            } catch {
                if (live) {
                    setFound({ dir, repos: [], self: false });
                }
            }
        });
        return () => {
            live = false;
        };
    }, [dir]);
    if (!dir || found == null || found.dir !== dir) {
        return { repos: null, self: false };
    }
    return { repos: found.repos, self: found.self };
}

type RepositoryClasses = { labelClassName?: string; selectClassName?: string; hintClassName?: string };

// The "Code repository" field: the repositories found in the folder, or none.
export function RepositoryField({
    dir,
    value,
    onChange,
    ...classes
}: { dir: string; value: string; onChange: (repo: string) => void } & RepositoryClasses) {
    const found = useFolderRepositories(dir);
    return <RepositoryChoice dir={dir} value={value} found={found} onChange={onChange} {...classes} />;
}

// What the field shows for the repositories found so far (null: still being read). A folder that is itself a
// repository offers no choice: the project works on it as before, and the field says so.
export function RepositoryChoice({
    dir,
    value,
    found,
    onChange,
    labelClassName,
    selectClassName,
    hintClassName,
}: {
    dir: string;
    value: string;
    found: FolderRepositories;
    onChange: (repo: string) => void;
} & RepositoryClasses) {
    const t = useT();
    const id = useId();
    const { repos, self } = found;
    if (!dir) {
        return null;
    }
    if (self) {
        return (
            <div className={hintClassName} data-role="repo-self">
                {t("projectRepo.folderIsRepo")}
            </div>
        );
    }
    const chosen = projectRepoOf(dir, value);
    const values = repositoryValues(dir, repos ?? [], value);
    return (
        <div className="min-w-0" data-field="repository">
            <label htmlFor={id} className={labelClassName}>
                {t("projectRepo.label")}
            </label>
            <select
                id={id}
                className={selectClassName}
                value={chosen === dir ? "" : chosen}
                disabled={repos == null}
                data-testid="project-repo"
                onChange={(e) => onChange(e.target.value)}
            >
                <option value="">
                    {repos != null && repos.length === 0 ? t("projectRepo.noneFound") : t("projectRepo.none")}
                </option>
                {values.map((repo) => (
                    <option key={repo} value={repo}>
                        {repositoryLabel(dir, repo)}
                    </option>
                ))}
            </select>
            <div className={hintClassName}>{t("projectRepo.hint")}</div>
        </div>
    );
}
