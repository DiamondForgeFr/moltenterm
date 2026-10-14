// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's pure helpers (FR-REV-002): the file tree, the viewed marks, the collapsed files' wording and the
// diff editor's language. Kept apart from the view so they can be tested.

import type { ReviewCollapsed, ReviewFile, ReviewFileStatus, ReviewState } from "./review-client";

// must match ReviewView in pkg/molten/review/tab.go
export const MoltentermReviewView = "molten-review";

export type TreeNode = {
    // name: the folder's or the file's name; a folder with a single folder inside shows both ("src/app").
    name: string;
    path: string;
    file?: ReviewFile;
    children?: TreeNode[];
};

function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
        const aDir = a.children != null;
        const bDir = b.children != null;
        if (aDir != bDir) {
            return aDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
        if (n.children != null) {
            sortNodes(n.children);
        }
    }
}

// Folders that hold a single folder and no file are shown as one row, as GitHub does.
function squash(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((n) => {
        if (n.children == null) {
            return n;
        }
        let node = n;
        while (node.children.length === 1 && node.children[0].children != null) {
            const only = node.children[0];
            node = { name: `${node.name}/${only.name}`, path: only.path, children: only.children };
        }
        return { ...node, children: squash(node.children) };
    });
}

// buildFileTree turns the PR's files into folders and files, folders first, each level by name.
export function buildFileTree(files: readonly ReviewFile[]): TreeNode[] {
    const root: TreeNode = { name: "", path: "", children: [] };
    for (const file of files ?? []) {
        const parts = file.path.split("/");
        let dir = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const path = parts.slice(0, i + 1).join("/");
            let next = dir.children.find((c) => c.children != null && c.path === path);
            if (next == null) {
                next = { name: parts[i], path, children: [] };
                dir.children.push(next);
            }
            dir = next;
        }
        dir.children.push({ name: parts[parts.length - 1], path: file.path, file });
    }
    sortNodes(root.children);
    return squash(root.children);
}

// treeFiles lists the files in the order the tree shows them.
export function treeFiles(nodes: readonly TreeNode[]): ReviewFile[] {
    const rtn: ReviewFile[] = [];
    const walk = (list: readonly TreeNode[]) => {
        for (const n of list) {
            if (n.file != null) {
                rtn.push(n.file);
            } else {
                walk(n.children ?? []);
            }
        }
    };
    walk(nodes);
    return rtn;
}

// A file is viewed while its head side is the one that was marked: a push that changes it unmarks it, as on GitHub.
export function isViewed(state: ReviewState, file: ReviewFile): boolean {
    const mark = state?.viewed?.[file.path];
    if (mark == null) {
        return false;
    }
    return mark === (file.newblob ?? "");
}

export function viewedCount(state: ReviewState, files: readonly ReviewFile[]): number {
    return (files ?? []).filter((f) => isViewed(state, f)).length;
}

// The first file to show: the first in the tree that is not collapsed, else the first.
export function firstFile(files: readonly ReviewFile[]): ReviewFile {
    return files.find((f) => !f.collapsed) ?? files[0] ?? null;
}

export function nextFile(files: readonly ReviewFile[], current: string, step: 1 | -1): ReviewFile {
    if (files.length === 0) {
        return null;
    }
    const index = files.findIndex((f) => f.path === current);
    if (index < 0) {
        return files[0];
    }
    return files[Math.min(files.length - 1, Math.max(0, index + step))];
}

export const StatusLetters: Record<ReviewFileStatus, { letter: string; label: string; tone: string }> = {
    added: { letter: "A", label: "added", tone: "text-success" },
    modified: { letter: "M", label: "modified", tone: "text-warning" },
    deleted: { letter: "D", label: "deleted", tone: "text-error" },
    renamed: { letter: "R", label: "renamed", tone: "text-accent" },
    copied: { letter: "C", label: "copied", tone: "text-accent" },
    typechanged: { letter: "T", label: "type changed", tone: "text-warning" },
    submodule: { letter: "S", label: "submodule", tone: "text-muted" },
};

export function formatBytes(n: number): string {
    if (!n) {
        return "0 B";
    }
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Why a file waits for Load (AC3), in one sentence.
export function collapsedReason(collapsed: ReviewCollapsed, file?: ReviewFile): string {
    switch (collapsed) {
        case "binary":
            return "Binary file: it is not shown as text.";
        case "generated":
            return "Generated file (lock file, generated code or marked linguist-generated): collapsed.";
        case "large": {
            const size = Math.max(file?.oldsize ?? 0, file?.newsize ?? 0);
            return `Large file${size > 0 ? ` (${formatBytes(size)})` : ""}: over 1 MB or 20,000 lines, collapsed.`;
        }
        case "submodule":
            return "Submodule: its commit changed; its content lives in another repository.";
    }
    return "";
}

export function collapsedTag(collapsed: ReviewCollapsed): string {
    switch (collapsed) {
        case "binary":
            return "binary";
        case "generated":
            return "generated";
        case "large":
            return "large";
        case "submodule":
            return "submodule";
    }
    return "";
}

// Monaco's language for a path; Monaco cannot infer it from the diff's model URIs.
const LanguagesByExt: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "json",
    go: "go",
    md: "markdown",
    mdx: "markdown",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    xml: "xml",
    svg: "xml",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    py: "python",
    rb: "ruby",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sql: "sql",
    lua: "lua",
    dart: "dart",
    toml: "ini",
    ini: "ini",
    dockerfile: "dockerfile",
    graphql: "graphql",
    proto: "proto",
};

const LanguagesByName: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    "taskfile.yml": "yaml",
};

export function languageOf(path: string): string {
    const base = (path ?? "").split("/").pop().toLowerCase();
    if (LanguagesByName[base] != null) {
        return LanguagesByName[base];
    }
    const dot = base.lastIndexOf(".");
    if (dot < 0) {
        return undefined;
    }
    return LanguagesByExt[base.slice(dot + 1)];
}

// Side by side unless the editor:inlinediff setting asks for unified (AC2); the tab's toggle overrides it.
export function sideBySideOf(toggle: boolean, inlineDiffSetting: boolean): boolean {
    if (toggle != null) {
        return toggle;
    }
    return !inlineDiffSetting;
}

export function shortOid(oid: string): string {
    return (oid ?? "").slice(0, 7);
}

export function newCommitsLabel(commits: number, rewritten: boolean): string {
    if (rewritten) {
        return commits > 0 ? `${commits} new commit${commits > 1 ? "s" : ""} (rewritten)` : "head rewritten";
    }
    return `${commits} new commit${commits === 1 ? "" : "s"}`;
}
