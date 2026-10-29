// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Opacity field of the edit sheet's Workspace part (FR-SHELL-091, #1281): a slider from opaque to the readable
// minimum, Blur what is behind, a Texture with live tiles (#1294), and where the value is saved (this workspace or its
// project). The window follows the slider while it moves; the value is saved where it rests. When the window stays opaque, a line says why.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useId, useRef } from "react";
import { useT } from "./i18n/i18n";
import { nextToggleIndex, ToggleGroup, ToggleOption } from "./suite/suite";
import { ShownLook, useShownLook, WindowLookModel } from "./window-look";
import {
    clampOpacity,
    isTranslucent,
    LookScope,
    minOpacity,
    opacityPercent,
    OpacityStep,
    textureTone,
    WindowLook,
    withTexture,
} from "./window-look-model";
import {
    DefaultTextureIntensity,
    MinTextureIntensity,
    textureBackground,
    TextureIntensityStep,
    TextureKind,
    TextureKinds,
} from "./window-texture";
import { readWorkspaceProject } from "./workspace-project";

const SaveDelayMs = 250;

const Scopes: ToggleOption<LookScope>[] = [
    { value: "workspace", label: "workspace.look.thisWorkspace" },
    { value: "project", label: "workspace.look.theProject" },
];

export function lookNote(shown: ShownLook): string {
    if (shown.reason === "reducedTransparency") {
        return "workspace.look.reducedTransparency";
    }
    if (shown.reason === "unsupported") {
        return "workspace.look.unsupported";
    }
    if (shown.wanted.blur && !shown.support.blur) {
        return "workspace.look.noBlur";
    }
    if (shown.source === "global") {
        return "workspace.look.fromSettings";
    }
    if (shown.source === "project") {
        return "workspace.look.fromProject";
    }
    return null;
}

// A choice's tile: the window's cast-iron frame (FR-SHELL-115) with the texture as the window would draw it. Over a
// see-through frame the ink is dark, so the tile lays the frame over a mid grey standing for what is behind.
function textureTileStyle(kind: TextureKind, look: WindowLook, drawn: WindowLook): React.CSSProperties {
    const translucent = isTranslucent(drawn);
    const frame = "var(--mt-surface-0)";
    const backgroundColor = translucent
        ? `color-mix(in srgb, ${frame} ${Math.round(drawn.opacity * 100)}%, rgb(150 150 150))`
        : frame;
    const texture = textureBackground(kind, look.intensity, textureTone(drawn));
    return texture == null
        ? { backgroundColor }
        : { backgroundColor, backgroundImage: texture.image, backgroundSize: texture.size };
}

export function TextureControl({
    shown,
    onLook,
    onCommit,
}: {
    shown: ShownLook;
    onLook: (look: WindowLook) => void;
    onCommit: () => void;
}) {
    const t = useT();
    const labelId = useId();
    const sliderId = useId();
    const groupRef = useRef<HTMLDivElement>(null);
    const look = shown.wanted;
    const selected: TextureKind = look.texture ?? "none";
    const selectedIndex = TextureKinds.indexOf(selected);
    const choose = (kind: TextureKind) => {
        onLook(withTexture(look, kind));
        onCommit();
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const radios = Array.from(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
        const next = nextToggleIndex(e.key, radios.indexOf(document.activeElement as HTMLElement), radios.length);
        if (next < 0) {
            return;
        }
        e.preventDefault();
        radios[next]?.focus();
        choose(TextureKinds[next]);
    };
    const intensity = Math.round((look.intensity ?? DefaultTextureIntensity) * 100);
    return (
        <div className="flex min-w-0 flex-col gap-1.5" data-role="texture-field">
            <div id={labelId} className="text-12 text-secondary">
                {t("workspace.look.texture")}
            </div>
            <div
                ref={groupRef}
                role="radiogroup"
                aria-labelledby={labelId}
                onKeyDown={onKeyDown}
                className="flex flex-wrap gap-2"
            >
                {TextureKinds.map((kind, i) => {
                    const checked = kind === selected;
                    return (
                        <button
                            key={kind}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            tabIndex={i === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1}
                            onClick={() => choose(kind)}
                            data-texture={kind}
                            className="group flex cursor-pointer flex-col items-center gap-1 rounded-4 p-0.5 text-11 text-muted outline-none hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring) aria-checked:text-primary"
                        >
                            <span
                                aria-hidden
                                data-role="texture-tile"
                                className={cn(
                                    "block h-7 w-11 rounded-4 border border-border",
                                    checked && "ring-2 ring-primary ring-offset-2 ring-offset-modalbg"
                                )}
                                style={textureTileStyle(kind, look, shown.drawn)}
                            />
                            {t(`workspace.look.textures.${kind}`)}
                        </button>
                    );
                })}
            </div>
            {selected === "grain" ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <label htmlFor={sliderId} className="text-12 text-secondary">
                        {t("workspace.look.intensity")}
                    </label>
                    <input
                        id={sliderId}
                        type="range"
                        min={Math.round(MinTextureIntensity * 100)}
                        max={100}
                        step={Math.round(TextureIntensityStep * 100)}
                        value={intensity}
                        aria-valuetext={t("workspace.look.percent", { percent: intensity })}
                        onChange={(e) => onLook(withTexture(look, "grain", Number(e.target.value) / 100))}
                        onPointerUp={onCommit}
                        onPointerCancel={onCommit}
                        onBlur={onCommit}
                        onKeyUp={onCommit}
                        data-role="texture-intensity"
                        className="h-4 w-36 cursor-pointer accent-[var(--mt-accent)]"
                    />
                    <span className="w-10 text-right text-12 tabular-nums text-secondary" aria-hidden>
                        {`${intensity} %`}
                    </span>
                </div>
            ) : null}
        </div>
    );
}

export function OpacityControl({
    shown,
    hasProject,
    onLook,
    onCommit,
    onScope,
}: {
    shown: ShownLook;
    hasProject: boolean;
    onLook: (look: WindowLook) => void;
    onCommit: () => void;
    onScope: (scope: LookScope) => void;
}) {
    const t = useT();
    const sliderId = useId();
    const look = shown.wanted;
    const unavailable = shown.reason === "unsupported";
    const note = lookNote(shown);
    const percent = opacityPercent(look.opacity);
    return (
        <div className="flex min-w-0 flex-col gap-2" data-role="opacity-field">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label htmlFor={sliderId} className="text-12 text-secondary">
                    {t("workspace.look.opacity")}
                </label>
                <input
                    id={sliderId}
                    type="range"
                    min={Math.round(minOpacity(look.blur) * 100)}
                    max={100}
                    step={Math.round(OpacityStep * 100)}
                    value={percent}
                    disabled={unavailable}
                    aria-valuetext={t("workspace.look.percent", { percent })}
                    onChange={(e) => onLook({ ...look, opacity: Number(e.target.value) / 100 })}
                    onPointerUp={onCommit}
                    onPointerCancel={onCommit}
                    onBlur={onCommit}
                    onKeyUp={onCommit}
                    className="h-4 w-36 cursor-pointer accent-[var(--mt-accent)] disabled:cursor-default disabled:opacity-60"
                />
                <span className="w-10 text-right text-12 tabular-nums text-secondary" aria-hidden>
                    {`${percent} %`}
                </span>
            </div>
            <div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={look.blur}
                    disabled={unavailable || !shown.support.blur}
                    onClick={() => {
                        const blur = !look.blur;
                        onLook({ ...look, blur, opacity: clampOpacity(look.opacity, blur) });
                        onCommit();
                    }}
                    data-action="look-blur"
                    className="inline-flex cursor-pointer items-center gap-2 rounded-4 px-1 text-12 text-secondary disabled:cursor-default disabled:opacity-60"
                >
                    <span className={cn("molten-cmdpanel-switch", look.blur && "is-on")} aria-hidden />
                    {t("workspace.look.blur")}
                </button>
            </div>
            <TextureControl shown={shown} onLook={onLook} onCommit={onCommit} />
            <div className="flex flex-wrap items-center justify-end gap-2">
                {hasProject ? (
                    <ToggleGroup<LookScope>
                        label={t("workspace.look.applyTo")}
                        options={Scopes.map((s) => ({ ...s, label: t(s.label) }))}
                        selected={shown.scope}
                        onSelect={onScope}
                    />
                ) : null}
            </div>
            <div className="text-12 text-muted" data-role="opacity-note" aria-live="polite">
                {note ? t(note) : t("workspace.look.framesOnly")}
            </div>
        </div>
    );
}

export function OpacityField({ ws }: { ws: Workspace }) {
    const model = WindowLookModel.getInstance();
    const shown = useShownLook(ws);
    const pending = useRef<WindowLook>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    const scopeRef = useRef<LookScope>(shown.scope);
    scopeRef.current = shown.scope;
    const save = () => {
        clearTimeout(timer.current);
        const look = pending.current;
        pending.current = null;
        if (look == null) {
            return;
        }
        fireAndForget(() => model.save(ws, scopeRef.current, look));
    };
    useEffect(
        () => () => {
            save();
            model.preview(ws.oid, null);
        },
        [ws.oid]
    );
    const onLook = (look: WindowLook) => {
        pending.current = look;
        model.preview(ws.oid, look);
        clearTimeout(timer.current);
        timer.current = setTimeout(save, SaveDelayMs);
    };
    const onScope = (scope: LookScope) => {
        clearTimeout(timer.current);
        pending.current = null;
        fireAndForget(() => model.save(ws, scope, shown.wanted));
    };
    return (
        <OpacityControl
            shown={shown}
            hasProject={readWorkspaceProject(ws).dir !== ""}
            onLook={onLook}
            onCommit={save}
            onScope={onScope}
        />
    );
}
