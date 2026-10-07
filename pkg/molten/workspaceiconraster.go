// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"encoding/binary"
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

func encodeWorkspaceIconPng(img image.Image, orientation int) ([]byte, error) {
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
	out := orientWorkspaceIcon(dst, orientation)
	var buf bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestCompression}
	if err := encoder.Encode(&buf, out); err != nil {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	return buf.Bytes(), nil
}

// Returns the 256 px PNG copy of a PNG, JPEG or WebP. A WebP the standard decoder refuses (an animated one) is kept as
// it is: it already passed the structural check and the size limit, and Chromium shows its first frame.
func NormalizeWorkspaceIconRaster(kind string, data []byte) ([]byte, string, error) {
	img, err := decodeWorkspaceIconRaster(kind, data)
	orientation := 1
	if kind == WorkspaceIconJpeg {
		orientation = readJpegOrientation(data)
	}
	if err != nil {
		if kind == WorkspaceIconWebp && IconRefusalReason(err) == IconRefusedUnreadable {
			return data, kind, nil
		}
		return nil, "", err
	}
	stored, err := encodeWorkspaceIconPng(img, orientation)
	if err != nil {
		return nil, "", err
	}
	return stored, WorkspaceIconPng, nil
}

// The centred square of a rotated or flipped image is the rotated or flipped centred square, so the orientation is
// applied to the small copy: the full-size image is never copied a second time.
func orientWorkspaceIcon(src *image.NRGBA, orientation int) *image.NRGBA {
	if orientation < 2 || orientation > 8 {
		return src
	}
	n := src.Bounds().Dx()
	dst := image.NewNRGBA(src.Bounds())
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			sx, sy := x, y
			switch orientation {
			case 2:
				sx = n - 1 - x
			case 3:
				sx, sy = n-1-x, n-1-y
			case 4:
				sy = n - 1 - y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, n-1-x
			case 7:
				sx, sy = n-1-y, n-1-x
			case 8:
				sx, sy = n-1-y, x
			}
			dst.SetNRGBA(x, y, src.NRGBAAt(sx, sy))
		}
	}
	return dst
}

const (
	exifOrientationTag = 0x0112
	maxExifIfdEntries  = 512
)

// The EXIF orientation (1 to 8) of a JPEG, or 1 when there is none or the segment is not well formed. Only the segments
// before the image data are walked and only inside the bytes given, so a crafted file can neither loop nor read past
// its end.
func readJpegOrientation(data []byte) int {
	pos := 2
	for pos+4 <= len(data) {
		if data[pos] != 0xFF {
			return 1
		}
		marker := data[pos+1]
		if marker == 0xFF {
			pos++
			continue
		}
		if marker == 0xDA || marker == 0xD9 {
			return 1
		}
		size := int(binary.BigEndian.Uint16(data[pos+2 : pos+4]))
		end := pos + 2 + size
		if size < 2 || end > len(data) {
			return 1
		}
		if marker == 0xE1 && size >= 8 && string(data[pos+4:pos+10]) == "Exif\x00\x00" {
			return parseExifOrientation(data[pos+10 : end])
		}
		pos = end
	}
	return 1
}

func parseExifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(tiff[0:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return 1
	}
	ifd := int(order.Uint32(tiff[4:8]))
	if ifd < 8 || ifd > len(tiff)-2 {
		return 1
	}
	count := int(order.Uint16(tiff[ifd : ifd+2]))
	if count > maxExifIfdEntries {
		return 1
	}
	for i := 0; i < count; i++ {
		entry := ifd + 2 + 12*i
		if entry+12 > len(tiff) {
			return 1
		}
		if order.Uint16(tiff[entry:entry+2]) != exifOrientationTag {
			continue
		}
		if order.Uint16(tiff[entry+2:entry+4]) != 3 || order.Uint32(tiff[entry+4:entry+8]) != 1 {
			return 1
		}
		value := int(order.Uint16(tiff[entry+8 : entry+10]))
		if value < 1 || value > 8 {
			return 1
		}
		return value
	}
	return 1
}
