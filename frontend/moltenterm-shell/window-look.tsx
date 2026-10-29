// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace's look applied to the window (FR-SHELL-091, DS-SHELL-131, #1281). Each tab view draws its own
// workspace's look: the frame and the sidebar take the opacity as CSS alpha (html.mt-translucent, --mt-window-alpha,
// sidebar.css), the panels stay opaque, and a texture (#1294, window-texture.ts) lies on the same surfaces as
// --mt-frame-texture; Electron main is told only whether this view lets the desktop through and whether the window
// blurs it, and is told again when the view comes on screen, so a workspace switch switches the look. The rules are
// window-look-model.ts.

import { ClientModel } from "@/app/store/client-model";
import { atoms, getApi, getSettingsPrefixAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import {
    effectiveLook,
    isTranslucent,
    lookForWorkspace,
    LookScope,
    lookScope,
    LookSource,
    LookSupport,
    lookWrites,
    OpaqueReason,
    readProjectLook,
    readWorkspaceLook,
    textureTone,
    WindowLook,
} from "./window-look-model";
import "./window-look.css";
import { textureBackground } from "./window-texture";
import { readWorkspaceProject } from "./workspace-project";

const ReducedTransparencyQuery = "(prefers-reduced-transparency: reduce)";

export type ShownLook = {
    // What the workspace asks for, and where it comes from.
    wanted: WindowLook;
    source: LookSource;
    scope: LookScope;
    // What the window draws, and why it is opaque when it differs.
    drawn: WindowLook;
    reason: OpaqueReason;
    support: LookSupport;
};

export class WindowLookModel {
    private static instance: WindowLookModel = null;

    supportAtom = jotai.atom(null) as jotai.PrimitiveAtom<LookSupport>;
    reducedTransparencyAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    // A value being dragged on the slider, drawn at once and saved where it rests.
    previewAtom = jotai.atom(null) as jotai.PrimitiveAtom<{ workspaceId: string; look: WindowLook }>;
    // The look of the workspace this tab view shows.
    windowLookAtom!: jotai.Atom<ShownLook>;

    private constructor() {
        this.windowLookAtom = jotai.atom((get) => this.shownLook(get, get(atoms.workspace)));
    }

    static getInstance(): WindowLookModel {
        if (WindowLookModel.instance == null) {
            WindowLookModel.instance = new WindowLookModel();
        }
        return WindowLookModel.instance;
    }

    clientMeta(get: jotai.Getter): Record<string, any> {
        const clientAtom = ClientModel.getInstance().clientAtom;
        return clientAtom == null ? null : get(clientAtom)?.meta;
    }

    // The look of a workspace, as the sheet and the window read it.
    shownLook(get: jotai.Getter, ws: Workspace): ShownLook {
        const settings = get(getSettingsPrefixAtom("window")) as Record<string, any>;
        const clientMeta = this.clientMeta(get);
        const projectDir = readWorkspaceProject(ws).dir;
        const resolved = lookForWorkspace(ws, projectDir, clientMeta, settings);
        const preview = get(this.previewAtom);
        const wanted = preview != null && preview.workspaceId === ws?.oid ? preview.look : resolved.look;
        const support = get(this.supportAtom) ?? { translucent: false, blur: false };
        const drawn = effectiveLook(wanted, get(this.reducedTransparencyAtom), support);
        return {
            wanted,
            source: resolved.source,
            scope: lookScope(readWorkspaceLook(ws), readProjectLook(clientMeta, projectDir), projectDir !== ""),
            drawn: drawn.look,
            reason: drawn.reason,
            support,
        };
    }

    preview(workspaceId: string, look: WindowLook) {
        globalStore.set(this.previewAtom, look == null ? null : { workspaceId, look });
    }

    async save(ws: Workspace, scope: LookScope, look: WindowLook) {
        const clientAtom = ClientModel.getInstance().clientAtom;
        const clientMeta = clientAtom == null ? null : globalStore.get(clientAtom)?.meta;
        const writes = lookWrites(scope, look, readWorkspaceProject(ws).dir, clientMeta);
        if (writes.client != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("client", ClientModel.getInstance().clientId),
                meta: writes.client as MetaType,
            });
        }
        if (writes.workspace != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("workspace", ws.oid),
                meta: writes.workspace as MetaType,
            });
        }
        if (globalStore.get(this.previewAtom)?.workspaceId === ws.oid) {
            globalStore.set(this.previewAtom, null);
        }
    }
}

function drawLook(look: WindowLook) {
    const root = document.documentElement;
    const translucent = isTranslucent(look);
    root.classList.toggle("mt-translucent", translucent);
    root.classList.toggle("mt-window-blur", translucent && look.blur);
    if (translucent) {
        root.style.setProperty("--mt-window-alpha", String(look.opacity));
    } else {
        root.style.removeProperty("--mt-window-alpha");
    }
    const texture = textureBackground(look.texture, look.intensity, textureTone(look));
    root.classList.toggle("mt-textured", texture != null);
    if (texture != null) {
        root.style.setProperty("--mt-frame-texture", texture.image);
        root.style.setProperty("--mt-frame-texture-size", texture.size);
    } else {
        root.style.removeProperty("--mt-frame-texture");
        root.style.removeProperty("--mt-frame-texture-size");
    }
}

function tellWindow(look: WindowLook) {
    if (document.visibilityState !== "visible") {
        return;
    }
    getApi().setWindowLook?.({ translucent: isTranslucent(look), blur: isTranslucent(look) && look.blur });
}

// Mounted once per tab view (app.tsx).
export function WindowLookApplier() {
    const model = WindowLookModel.getInstance();
    const ws = useAtomValue(atoms.workspace);
    const shown = useAtomValue(model.windowLookAtom);
    useEffect(() => {
        let live = true;
        getApi()
            .getWindowLookSupport?.()
            .then((support) => {
                if (live) {
                    globalStore.set(model.supportAtom, support ?? { translucent: false, blur: false });
                }
            })
            .catch(() => {});
        const query = window.matchMedia?.(ReducedTransparencyQuery);
        const onQuery = () => globalStore.set(model.reducedTransparencyAtom, query?.matches === true);
        onQuery();
        query?.addEventListener?.("change", onQuery);
        return () => {
            live = false;
            query?.removeEventListener?.("change", onQuery);
        };
    }, []);
    const drawn = shown.drawn;
    useEffect(() => {
        drawLook(drawn);
        tellWindow(drawn);
        const onVisible = () => tellWindow(drawn);
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, [drawn.opacity, drawn.blur, drawn.texture, drawn.intensity, ws?.oid]);
    return null;
}

// The look of the workspace the sheet edits (it may not be the one the window shows).
export function useShownLook(ws: Workspace): ShownLook {
    const model = WindowLookModel.getInstance();
    const atom = useMemo(() => jotai.atom((get) => model.shownLook(get, ws)), [ws]);
    return useAtomValue(atom);
}
