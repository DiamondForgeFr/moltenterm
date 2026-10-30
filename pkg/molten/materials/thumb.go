// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"os"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// The preview image of a picture (AC9): at most ThumbPx on its long side and ThumbBytes, made once from the copy. A
// page's, a PDF's and a video's come with the library preview (FR-MAT-004).

const thumbMaxPixels = 64 * 1024 * 1024

func makeThumb(path string, maxPx int, maxBytes int) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > thumbMaxPixels {
		return nil
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil
	}
	src, _, err := image.Decode(f)
	if err != nil {
		return nil
	}
	side := maxPx
	for side >= 64 {
		out := scaleTo(src, side)
		var buf bytes.Buffer
		if png.Encode(&buf, out) == nil && buf.Len() <= maxBytes {
			return buf.Bytes()
		}
		side = side * 3 / 4
	}
	return nil
}

func scaleTo(src image.Image, side int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= side && h <= side {
		dst := image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
		return dst
	}
	nw, nh := side, h*side/w
	if h > w {
		nw, nh = w*side/h, side
	}
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, nw, nh))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	return dst
}
