// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CSSProperties } from "react";
import { XYCoord } from "react-dnd";
import { DropDirection, FlexDirection, NavigateDirection } from "./types";

export function reverseFlexDirection(flexDirection: FlexDirection): FlexDirection {
    return flexDirection === FlexDirection.Row ? FlexDirection.Column : FlexDirection.Row;
}

export function determineDropDirection(dimensions?: Dimensions, offset?: XYCoord | null): DropDirection | undefined {
    // console.log("determineDropDirection", dimensions, offset);
    if (!offset || !dimensions) return undefined;
    const { width, height, left, top } = dimensions;
    let { x, y } = offset;
    x -= left;
    y -= top;

    // Lies outside of the box
    if (y < 0 || y > height || x < 0 || x > width) return undefined;

    // Determines if a drop point falls within the center fifth of the box, meaning we should return Center.
    const centerX1 = (2 * width) / 5;
    const centerX2 = (3 * width) / 5;
    const centerY1 = (2 * height) / 5;
    const centerY2 = (3 * height) / 5;

    if (x > centerX1 && x < centerX2 && y > centerY1 && y < centerY2) return DropDirection.Center;

    const diagonal1 = y * width - x * height;
    const diagonal2 = y * width + x * height - height * width;

    // Lies on diagonal
    if (diagonal1 == 0 || diagonal2 == 0) return undefined;

    let code = 0;

    if (diagonal2 > 0) {
        code += 1;
    }

    if (diagonal1 > 0) {
        code += 2;
        code = 5 - code;
    }

    // Determines whether a drop is close to an edge of the box, meaning drop direction should be OuterX, instead of X
    const xOuter1 = width / 5;
    const xOuter2 = width - width / 5;
    const yOuter1 = height / 5;
    const yOuter2 = height - height / 5;

    if (y < yOuter1 || y > yOuter2 || x < xOuter1 || x > xOuter2) {
        code += 4;
    }

    return code;
}

export function setTransform(
    { top, left, width, height }: Dimensions,
    setSize = true,
    roundVals = true,
    zIndex?: number | string
): CSSProperties {
    // Replace unitless items with px
    // MOLTENTERM-PATCH (#1220): round the edges, not the sizes. Flooring the start and ceiling the size made two
    // adjacent tiles overlap by a pixel whenever a split fell between pixels, so that gap came out a pixel narrower
    // than the others; rounded edges are shared exactly by neighbours.
    const topRounded = roundVals ? Math.round(top) : top;
    const leftRounded = roundVals ? Math.round(left) : left;
    const widthRounded = roundVals ? Math.round(left + width) - leftRounded : width;
    const heightRounded = roundVals ? Math.round(top + height) - topRounded : height;
    const translate = `translate3d(${leftRounded}px,${topRounded}px, 0)`;
    return {
        top: 0,
        left: 0,
        transform: translate,
        width: setSize ? `${widthRounded}px` : undefined,
        height: setSize ? `${heightRounded}px` : undefined,
        position: "absolute",
        zIndex: zIndex,
    };
}

// MOLTENTERM-PATCH (#1240): a resize handle is centred on the rounded edge the neighbouring tiles share (setTransform),
// not on the unrounded boundary, which put the grip up to half a pixel off the middle of the gap. The handle size is
// twice the gap, so its half is a whole number of pixels for a whole gap.
export function resizeHandleDimensions(lastChildRect: Dimensions, isRow: boolean, handleSizePx: number): Dimensions {
    const half = handleSizePx / 2;
    if (isRow) {
        const top = Math.round(lastChildRect.top);
        return {
            top,
            left: Math.round(lastChildRect.left + lastChildRect.width) - half,
            width: handleSizePx,
            height: Math.round(lastChildRect.top + lastChildRect.height) - top,
        };
    }
    const left = Math.round(lastChildRect.left);
    return {
        top: Math.round(lastChildRect.top + lastChildRect.height) - half,
        left,
        width: Math.round(lastChildRect.left + lastChildRect.width) - left,
        height: handleSizePx,
    };
}

export function getCenter(dimensions: Dimensions): Point {
    return {
        x: dimensions.left + dimensions.width / 2,
        y: dimensions.top + dimensions.height / 2,
    };
}

export function navigateDirectionToOffset(direction: NavigateDirection): Point {
    switch (direction) {
        case NavigateDirection.Up:
            return { x: 0, y: -1 };
        case NavigateDirection.Down:
            return { x: 0, y: 1 };
        case NavigateDirection.Left:
            return { x: -1, y: 0 };
        case NavigateDirection.Right:
            return { x: 1, y: 0 };
    }
}
