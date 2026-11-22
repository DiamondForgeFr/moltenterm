// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's popovers (FR-SHELL-018, #2455). One surface per companion panel, in place of the system tooltip each
// `title` would have drawn: an element names its text with data-tip, a pasted image's chip names its number with
// data-image, and this host listens to the panel for both. It opens after a pause on hover and on keyboard focus,
// closes on leaving, on blur, on a press and on Escape, flips and shifts to stay inside the panel, and gives the
// element it describes an aria-describedby to it while it is open. It never takes the focus or a click, so the
// element keeps both: a click on an image's chip opens the image full size.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    autoUpdate,
    flip,
    FloatingPortal,
    offset,
    shift,
    size,
    type UseFloatingOptions,
    type VirtualElement,
} from "@floating-ui/react";
import {
    lazy,
    Suspense,
    useCallback,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { formatSize } from "../downloads/downloads-format";
import { useFloatingInPlace } from "../floating-in-place";
import { useT } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { always, TabActivity } from "../tab-activity";
import { ImageAccess, ImageAccessContext, useChipImage, useImagePixels } from "./companion-image-access";
import { CompanionImageCommand, CompanionRoute } from "./companion-model";
import {
    CloseTipsEvent,
    CompanionImage,
    contentsRect,
    FocusDelayMs,
    HoverDelayMs,
    imageBytes,
    ImageCache,
    ImageMaxHeight,
    ImageMaxWidth,
    imageSource,
    TipAttr,
    TipTarget,
    tipTargetOf,
} from "./companion-tips-model";
import "./companion-tips.css";

// The full-size image is an overlay of its own, loaded when a chip is first clicked.
const ImageDialog = lazy(() => import("./companion-image-dialog").then((m) => ({ default: m.ImageDialog })));

const ImageTimeoutMs = 20000;
// How often an open popover checks that its element is still there and still says the same.
const WatchMs = 400;

export type ImageLoader = (n: number, at: number) => Promise<CompanionImage>;

export function readCompanionImage(target: string): ImageLoader {
    return (n, at) =>
        TabRpcClient.wshRpcCall(
            CompanionImageCommand,
            { blockid: target, n, at },
            { route: CompanionRoute, timeout: ImageTimeoutMs }
        );
}

function focusVisible(element: Element): boolean {
    try {
        return element.matches(":focus-visible");
    } catch {
        return true;
    }
}

function describe(element: HTMLElement, id: string) {
    const current = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((s) => !!s && s !== id);
    element.setAttribute("aria-describedby", [...current, id].join(" "));
}

function undescribe(element: HTMLElement, id: string) {
    const rest = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((s) => !!s && s !== id);
    if (rest.length === 0) {
        element.removeAttribute("aria-describedby");
        return;
    }
    element.setAttribute("aria-describedby", rest.join(" "));
}

// CompanionTips wraps a companion panel's content. Inside another one it does nothing: the outer host serves both.
export function CompanionTips({
    target,
    session,
    loadImage,
    children,
}: {
    // The companion's terminal, whose session holds the images.
    target: string;
    // The session shown (its path): an image is cached under it.
    session: string;
    // The way an image is read, wavesrv's by default (the preview and the tests give their own).
    loadImage?: ImageLoader;
    children: React.ReactNode;
}) {
    if (useContext(ImageAccessContext) != null) {
        return <>{children}</>;
    }
    return (
        <TipsHost target={target} session={session} loadImage={loadImage}>
            {children}
        </TipsHost>
    );
}

function TipsHost({
    target,
    session,
    loadImage,
    children,
}: {
    target: string;
    session: string;
    loadImage?: ImageLoader;
    children: React.ReactNode;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const id = useId();
    const [shown, setShown] = useState<TipTarget>(null);
    const [asked, setAsked] = useState(false);
    const [full, setFull] = useState<{ n: number; at: number }>(null);
    const shownRef = useRef<TipTarget>(null);
    const activeRef = useRef<HTMLElement>(null);
    const timerRef = useRef(0);
    const cache = useMemo(() => new ImageCache(), []);
    const read = useMemo(() => loadImage ?? readCompanionImage(target), [loadImage, target]);
    useEffect(() => () => cache.clear(), [cache, session, target]);
    const access = useMemo<ImageAccess>(
        () => ({ load: (n, at) => cache.load(`${target}|${session}|${n}|${at}`, () => read(n, at)) }),
        [cache, read, session, target]
    );

    const show = useCallback((next: TipTarget) => {
        shownRef.current = next;
        setShown(next);
    }, []);
    const close = useCallback(() => {
        window.clearTimeout(timerRef.current);
        timerRef.current = 0;
        activeRef.current = null;
        setAsked(false);
        show(null);
    }, [show]);
    // A tip already open follows the pointer to the next element at once, as a system tooltip does.
    const ask = useCallback(
        (next: TipTarget, delay: number) => {
            if (activeRef.current === next.element) {
                return;
            }
            window.clearTimeout(timerRef.current);
            activeRef.current = next.element;
            setAsked(true);
            if (next.kind === "image") {
                access.load(next.n, next.at).catch(() => {});
            }
            if (shownRef.current != null) {
                show(next);
                return;
            }
            timerRef.current = window.setTimeout(() => show(next), delay);
        },
        [access, show]
    );
    useEffect(() => close, [close]);
    useEffect(() => {
        document.addEventListener(CloseTipsEvent, close);
        return () => document.removeEventListener(CloseTipsEvent, close);
    }, [close]);

    useEffect(() => {
        if (!asked) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") {
                return;
            }
            e.stopPropagation();
            close();
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, [asked, close]);

    useEffect(() => {
        if (shown == null) {
            return;
        }
        describe(shown.element, id);
        return () => undescribe(shown.element, id);
    }, [shown?.element, id]);

    const onPointerOver = (e: React.PointerEvent) => {
        if (e.pointerType === "touch") {
            return;
        }
        const next = tipTargetOf(e.target, rootRef.current?.parentElement);
        if (next == null) {
            if (activeRef.current != null && !activeRef.current.contains(e.target as Node)) {
                close();
            }
            return;
        }
        ask(next, HoverDelayMs);
    };
    const onPointerOut = (e: React.PointerEvent) => {
        const active = activeRef.current;
        if (active == null || (e.relatedTarget != null && active.contains(e.relatedTarget as Node))) {
            return;
        }
        close();
    };
    const onFocus = (e: React.FocusEvent) => {
        const next = tipTargetOf(e.target, rootRef.current?.parentElement);
        if (next == null || !focusVisible(next.element)) {
            return;
        }
        ask(next, FocusDelayMs);
    };
    const onBlur = (e: React.FocusEvent) => {
        if (activeRef.current != null && activeRef.current.contains(e.target as Node)) {
            close();
        }
    };
    const onClick = (e: React.MouseEvent) => {
        const next = tipTargetOf(e.target, rootRef.current?.parentElement);
        if (next?.kind !== "image") {
            return;
        }
        e.preventDefault();
        close();
        setFull({ n: next.n, at: next.at });
    };

    return (
        <ImageAccessContext.Provider value={access}>
            <div
                ref={rootRef}
                className="contents"
                onPointerOver={onPointerOver}
                onPointerOut={onPointerOut}
                onPointerDown={close}
                onFocus={onFocus}
                onBlur={onBlur}
                onClick={onClick}
            >
                {children}
            </div>
            {shown != null ? (
                <TipSurface
                    key={shown.kind === "image" ? `image-${shown.n}` : "text"}
                    target={shown}
                    id={id}
                    boundary={rootRef.current?.parentElement}
                    onGone={close}
                    onText={show}
                />
            ) : null}
            {full != null ? (
                <Suspense fallback={null}>
                    <ImageDialog n={full.n} at={full.at} onClose={() => setFull(null)} />
                </Suspense>
            ) : null}
        </ImageAccessContext.Provider>
    );
}

// What the popover is placed against when the element has no box of its own (display: contents): the boxes it holds.
// null for any other element, which is placed against itself.
function tipPlacement(element: HTMLElement): VirtualElement {
    if (getComputedStyle(element).display !== "contents") {
        return null;
    }
    return {
        contextElement: element,
        getBoundingClientRect: () => (contentsRect(element) ?? element.getBoundingClientRect()) as DOMRect,
    };
}

function TipSurface({
    target,
    id,
    boundary,
    onGone,
    onText,
}: {
    target: TipTarget;
    id: string;
    boundary: HTMLElement;
    onGone: () => void;
    onText: (next: TipTarget) => void;
}) {
    const detect = { boundary: boundary ?? undefined, padding: 6 };
    const placement = useMemo(() => tipPlacement(target.element), [target.element]);
    const options: Partial<UseFloatingOptions> = {
        open: true,
        placement: "top",
        elements: { reference: target.element },
        middleware: [
            offset(6),
            flip(detect),
            shift(detect),
            size({
                ...detect,
                apply({ availableWidth, elements }) {
                    const wide = target.kind === "image" ? ImageMaxWidth + 24 : 300;
                    elements.floating.style.maxWidth = `${Math.max(120, Math.min(wide, availableWidth))}px`;
                },
            }),
        ],
        whileElementsMounted: autoUpdate,
    };
    const { refs, floatingStyles } = useFloatingInPlace(options);
    useLayoutEffect(() => {
        refs.setPositionReference(placement);
    }, [refs, placement]);
    useEffect(
        () =>
            TabActivity.getInstance().every(
                always(WatchMs),
                () => {
                    const element = target.element;
                    if (!element.isConnected) {
                        onGone();
                        return;
                    }
                    if (target.kind !== "text") {
                        return;
                    }
                    const text = element.getAttribute(TipAttr);
                    if (!text) {
                        onGone();
                    } else if (text !== target.text) {
                        onText({ ...target, text });
                    }
                },
                "companion-tip-watch"
            ),
        [target, onGone, onText]
    );
    return (
        <FloatingPortal>
            <div ref={refs.setFloating} style={floatingStyles} className="mt-tip-pos" data-testid="companion-tip-pos">
                <div id={id} role="tooltip" className="mt-tip" data-kind={target.kind} data-testid="companion-tip">
                    {target.kind === "image" ? <ImageTip n={target.n} at={target.at} /> : target.text}
                </div>
            </div>
        </FloatingPortal>
    );
}

// The image's own popover: the image fitted in the bounds, its size in pixels and bytes, or why there is none.
export function ImageTip({ n, at }: { n: number; at: number }) {
    const image = useChipImage(n, at);
    const [pixels, setPixels] = useImagePixels(image);
    return <ImageTipView n={n} image={image} pixels={pixels} onPixels={setPixels} />;
}

// undefined: being read; null: not found.
export function ImageTipView({
    n,
    image,
    pixels,
    onPixels,
}: {
    n: number;
    image: CompanionImage;
    pixels: [number, number];
    onPixels: (pixels: [number, number]) => void;
}) {
    const t = useT();
    if (image === undefined) {
        return (
            <span className="mt-tip-note" data-testid="companion-image-loading">
                <DominoLoader className="mr-1.5" />
                {t("common.loading")}
            </span>
        );
    }
    if (image === null) {
        return (
            <span className="mt-tip-note" data-testid="companion-image-unavailable">
                {t("companion.image.unavailable")}
            </span>
        );
    }
    const bytes = formatSize(imageBytes(image));
    return (
        <span className="mt-tip-image" data-testid="companion-image-preview">
            <img
                src={imageSource(image)}
                alt={t("companion.image.alt", { n })}
                style={{ maxWidth: ImageMaxWidth, maxHeight: ImageMaxHeight }}
                onLoad={(e) => onPixels([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
            />
            <span className="mt-tip-meta tabular-nums">
                {pixels != null ? t("companion.image.size", { width: pixels[0], height: pixels[1], bytes }) : bytes}
            </span>
        </span>
    );
}
