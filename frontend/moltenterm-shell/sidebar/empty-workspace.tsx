// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace without a view of its own (FR-SHELL-110, audit #1316 F5): where its tiles would be, what a workspace is,
// why this one shows none and how to start, with two actions: the template's views (FR-SHELL-092) or a view of one's
// own. Nothing is added until the developer asks; the first run, which gives a fresh install's starter workspace its
// views when it ends, keeps the place quiet meanwhile.

import { ClientModel } from "@/app/store/client-model";
import { atoms } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { isPending } from "../../moltenterm-onboarding/onboarding-state";
import { EmptyState } from "../empty-state";
import { useLocale, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { openNewView } from "../newview/new-view";
import { templateViewsText, useTemplateViews } from "../workspace-views/template-views";

export function EmptyWorkspace() {
    const t = useT();
    const locale = useLocale();
    const ws = useAtomValue(atoms.workspace);
    const client = useAtomValue(ClientModel.getInstance().clientAtom);
    const template = useTemplateViews();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    if (ws == null || isPending(client?.meta)) {
        return null;
    }
    const addViews = async () => {
        setBusy(true);
        setError(null);
        try {
            // The views appear as tiles in this place; the one on screen stays.
            await WorkspaceService.AddWorkspaceViews(ws.oid);
        } catch (e) {
            setError(serverErrorText(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <EmptyWorkspaceState
            viewsText={template.length > 0 ? templateViewsText(template, t, locale) : ""}
            busy={busy}
            error={error}
            onAddViews={() => void addViews()}
            onNewView={openNewView}
        />
    );
}

type EmptyWorkspaceStateProps = {
    // The template's views as a phrase; empty when the template has none, and then only a new view is offered.
    viewsText: string;
    busy: boolean;
    error: string;
    onAddViews: () => void;
    onNewView: () => void;
};

export function EmptyWorkspaceState({ viewsText, busy, error, onAddViews, onNewView }: EmptyWorkspaceStateProps) {
    const t = useT();
    const newView = { label: t("sidebar.emptyWorkspace.newView"), testId: "empty-workspace-new-view", onClick: onNewView };
    const addViews = {
        label: t("sidebar.emptyWorkspace.addViews"),
        busy,
        testId: "empty-workspace-add-views",
        onClick: onAddViews,
    };
    return (
        <EmptyState
            icon="table-cells-large"
            title={t("sidebar.emptyWorkspace.title")}
            hint={
                viewsText
                    ? t("sidebar.emptyWorkspace.hint", { views: viewsText })
                    : t("sidebar.emptyWorkspace.hintNoTemplate")
            }
            primary={viewsText ? addViews : newView}
            secondary={viewsText ? newView : null}
            alert={error}
            compact
            className="px-2 pt-4 pb-2"
            testId="empty-workspace"
        />
    );
}
