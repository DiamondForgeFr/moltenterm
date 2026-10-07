// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

// The stored copy of a raster icon (NFR-SHELL-016, #316): a badge is 24 px, so the original is not kept. It is decoded
// once, cropped to a centred square (the badge crops the same way) and scaled down to at most this side, then stored
// as PNG. Nothing is scaled up: a smaller image keeps its own size, so it is never blurred nor made heavier.
//
// Icons stored before #316 are not converted at start-up: #295 has shipped in no release, so a start-up pass that
// rewrites workspace meta is not worth its risk. They keep working as they are and get the 256 px copy on their next
// import.
const StoredWorkspaceIconSide = 256

// The dimensions come from the header and are checked before the image is decoded, so a small file declaring a huge
// image is refused without allocating it.
func decodeWorkspaceIconRaster(kind string, data []byte) (image.Image, error) {
	var cfg image.Config
	var err error
	switch kind {
	case WorkspaceIconPng:
		cfg, err = png.DecodeConfig(bytes.NewReader(data))
	case WorkspaceIconJpeg:
		cfg, err = jpeg.DecodeConfig(bytes.NewReader(data))
	case WorkspaceIconWebp:
		cfg, err = webp.DecodeConfig(bytes.NewReader(data))
	}
	if err != nil {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	if err := checkIconSide(cfg.Width, cfg.Height); err != nil {
		return nil, err
	}
	var img image.Image
	switch kind {
	case WorkspaceIconPng:
		img, err = png.Decode(bytes.NewReader(data))
	case WorkspaceIconJpeg:
		img, err = jpeg.Decode(bytes.NewReader(data))
	case WorkspaceIconWebp:
		img, err = webp.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	return img, nil
}

func encodeWorkspaceIconPng(img image.Image) ([]byte, error) {
	src := img.Bounds()
	side := min(src.Dx(), src.Dy())
	if side <= 0 {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	target := min(side, StoredWorkspaceIconSide)
	square := image.Rect(
		src.Min.X+(src.Dx()-side)/2,
		src.Min.Y+(src.Dy()-side)/2,
		src.Min.X+(src.Dx()-side)/2+side,
		src.Min.Y+(src.Dy()-side)/2+side,
	)
	dst := image.NewNRGBA(image.Rect(0, 0, target, target))
	if side == target {
		draw.Draw(dst, dst.Bounds(), img, square.Min, draw.Src)
	} else {
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, square, draw.Src, nil)
	}
	var buf bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestCompression}
	if err := encoder.Encode(&buf, dst); err != nil {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	return buf.Bytes(), nil
}

// Returns the 256 px PNG copy of a PNG, JPEG or WebP. A WebP the standard decoder refuses (an animated one) is kept as
// it is: it already passed the structural check and the size limit, and Chromium shows its first frame.
func NormalizeWorkspaceIconRaster(kind string, data []byte) ([]byte, string, error) {
	img, err := decodeWorkspaceIconRaster(kind, data)
	if err != nil {
		if kind == WorkspaceIconWebp && IconRefusalReason(err) == IconRefusedUnreadable {
			return data, kind, nil
		}
		return nil, "", err
	}
	stored, err := encodeWorkspaceIconPng(img)
	if err != nil {
		return nil, "", err
	}
	return stored, WorkspaceIconPng, nil
}
