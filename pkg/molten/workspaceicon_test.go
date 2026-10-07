// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makePng(t *testing.T, w int, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func makeJpeg(t *testing.T, w int, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// A PNG whose IHDR declares w x h, with a valid CRC, and nothing behind it.
func makePngHeader(w uint32, h uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], w)
	binary.BigEndian.PutUint32(ihdr[4:8], h)
	ihdr[8] = 8
	ihdr[9] = 6
	var buf bytes.Buffer
	buf.Write(pngSignature)
	binary.Write(&buf, binary.BigEndian, uint32(13))
	chunk := append([]byte("IHDR"), ihdr...)
	buf.Write(chunk)
	binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return buf.Bytes()
}

func makeWebp(w int, h int) []byte {
	vp8l := make([]byte, 6)
	vp8l[0] = 0x2f
	binary.LittleEndian.PutUint32(vp8l[1:5], uint32(w-1)|uint32(h-1)<<14)
	var chunk bytes.Buffer
	chunk.WriteString("VP8L")
	binary.Write(&chunk, binary.LittleEndian, uint32(len(vp8l)))
	chunk.Write(vp8l)
	var buf bytes.Buffer
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(4+chunk.Len()))
	buf.WriteString("WEBP")
	buf.Write(chunk.Bytes())
	return buf.Bytes()
}

func makeIco(images ...[]byte) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 1, 0})
	binary.Write(&buf, binary.LittleEndian, uint16(len(images)))
	offset := 6 + 16*len(images)
	for _, img := range images {
		entry := make([]byte, 16)
		binary.LittleEndian.PutUint32(entry[8:12], uint32(len(img)))
		binary.LittleEndian.PutUint32(entry[12:16], uint32(offset))
		buf.Write(entry)
		offset += len(img)
	}
	for _, img := range images {
		buf.Write(img)
	}
	return buf.Bytes()
}

// count directory entries that all point at the same image: the decode-it-thousands-of-times attack.
func makeOverlappingIco(img []byte, count int) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 1, 0})
	binary.Write(&buf, binary.LittleEndian, uint16(count))
	offset := 6 + 16*count
	for i := 0; i < count; i++ {
		entry := make([]byte, 16)
		binary.LittleEndian.PutUint32(entry[8:12], uint32(len(img)))
		binary.LittleEndian.PutUint32(entry[12:16], uint32(offset))
		buf.Write(entry)
	}
	buf.Write(img)
	return buf.Bytes()
}

func makeBmpHeader(w int32, h int32) []byte {
	header := make([]byte, 40+16)
	binary.LittleEndian.PutUint32(header[0:4], 40)
	binary.LittleEndian.PutUint32(header[4:8], uint32(w))
	binary.LittleEndian.PutUint32(header[8:12], uint32(h*2))
	return header
}

func TestPrepareWorkspaceIcon(t *testing.T) {
	goodPng := makePng(t, 64, 32)
	cases := []struct {
		name   string
		data   []byte
		ext    string
		reason string
	}{
		{"png", goodPng, WorkspaceIconPng, ""},
		{"jpeg", makeJpeg(t, 40, 40), WorkspaceIconPng, ""},
		{"webp", makeWebp(128, 64), WorkspaceIconWebp, ""},
		{"ico with a png", makeIco(makePng(t, 32, 32)), WorkspaceIconIco, ""},
		{"ico with a bitmap", makeIco(makeBmpHeader(16, 16)), WorkspaceIconIco, ""},
		{"svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`), WorkspaceIconSvg, ""},
		{"text renamed to png", []byte("hello, I am not an image\n"), "", IconRefusedType},
		{"gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), "", IconRefusedType},
		{"empty", []byte{}, "", IconRefusedType},
		{"truncated png", goodPng[:len(goodPng)/2], "", IconRefusedUnreadable},
		{"png header only", makePngHeader(64, 64), "", IconRefusedUnreadable},
		{"png declaring 10000 x 10000", makePngHeader(10000, 10000), "", IconRefusedPixels},
		{"png 4097 wide", makePngHeader(4097, 10), "", IconRefusedPixels},
		{"truncated jpeg", makeJpeg(t, 40, 40)[:100], "", IconRefusedUnreadable},
		{"webp declaring 5000 x 10", makeWebp(5000, 10), "", IconRefusedPixels},
		{"webp with a lying size", append(makeWebp(10, 10)[:8], []byte("WEBPVP8L\xff\xff\x00\x00")...), "", IconRefusedUnreadable},
		{"webp without an image chunk", []byte("RIFF\x04\x00\x00\x00WEBP"), "", IconRefusedUnreadable},
		{"ico pointing outside the file", []byte{0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 0, 0, 0, 0, 0xff, 0, 0, 0, 22, 0, 0, 0}, "", IconRefusedUnreadable},
		{"ico without entries", []byte{0, 0, 1, 0, 0, 0}, "", IconRefusedUnreadable},
		{"ico with a huge bitmap", makeIco(makeBmpHeader(9000, 16)), "", IconRefusedUnreadable},
		{"ico with a 512 px png entry", makeIco(makePng(t, 512, 16)), "", IconRefusedUnreadable},
		{"ico with overlapping entries", makeOverlappingIco(makePng(t, 16, 16), 2), "", IconRefusedUnreadable},
		{"ico with thousands of entries on one image", makeOverlappingIco(makePng(t, 16, 16), 5000), "", IconRefusedUnreadable},
		{"ico with a truncated png", makeIco(goodPng[:40]), "", IconRefusedUnreadable},
		{"xml that is not svg", []byte(`<html><body>hi</body></html>`), "", IconRefusedType},
		{"oversized", append(bytes.Repeat([]byte{0}, MaxWorkspaceIconBytes), 1), "", IconRefusedTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, ext, err := PrepareWorkspaceIcon(tc.data)
			if got := IconRefusalReason(err); got != tc.reason {
				t.Fatalf("reason %q, want %q (err %v)", got, tc.reason, err)
			}
			if tc.reason == "" && err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if ext != tc.ext {
				t.Fatalf("ext %q, want %q", ext, tc.ext)
			}
		})
	}
}

func TestReadWorkspaceIconSource(t *testing.T) {
	dir := t.TempDir()
	big := filepath.Join(dir, "big.png")
	if err := os.WriteFile(big, append(makePng(t, 8, 8), bytes.Repeat([]byte{0}, 3*MaxWorkspaceIconBytes)...), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadWorkspaceIconSource(big); IconRefusalReason(err) != IconRefusedTooLarge {
		t.Fatalf("3 MB file: %v", err)
	}
	if _, err := ReadWorkspaceIconSource(dir); IconRefusalReason(err) != IconRefusedUnreadable {
		t.Fatalf("folder: %v", err)
	}
	if _, err := ReadWorkspaceIconSource(filepath.Join(dir, "missing.png")); IconRefusalReason(err) != IconRefusedUnreadable {
		t.Fatalf("missing file: %v", err)
	}
	exact := filepath.Join(dir, "exact.bin")
	if err := os.WriteFile(exact, bytes.Repeat([]byte{1}, MaxWorkspaceIconBytes), 0600); err != nil {
		t.Fatal(err)
	}
	if data, err := ReadWorkspaceIconSource(exact); err != nil || len(data) != MaxWorkspaceIconBytes {
		t.Fatalf("1 MB exactly: %d bytes, %v", len(data), err)
	}
}

func TestImportWorkspaceIconFile(t *testing.T) {
	src := t.TempDir()
	store := filepath.Join(t.TempDir(), WorkspaceIconsDirName)
	source := filepath.Join(src, "client logo.png")
	data := makePng(t, 20, 10)
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(source)
	name, err := ImportWorkspaceIconFile(store, "ws-1", source)
	if err != nil {
		t.Fatal(err)
	}
	if !CheckWorkspaceIconName(name) || !strings.HasPrefix(name, "ws-1-") || !strings.HasSuffix(name, ".png") {
		t.Fatalf("stored name %q", name)
	}
	if strings.Contains(name, "client") {
		t.Fatalf("the user's file name leaked into %q", name)
	}
	stored, err := os.ReadFile(filepath.Join(store, name))
	if err != nil {
		t.Fatalf("stored copy: %v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(stored))
	if err != nil || cfg.Width != 10 || cfg.Height != 10 {
		t.Fatalf("stored copy is %dx%d (%v), want the 10x10 centred square", cfg.Width, cfg.Height, err)
	}
	after, _ := os.Stat(source)
	if !after.ModTime().Equal(before.ModTime()) || after.Size() != before.Size() {
		t.Fatalf("the source file was modified")
	}
	// The source can go: the copy stays.
	os.Remove(source)
	if _, err := os.Stat(filepath.Join(store, name)); err != nil {
		t.Fatalf("copy gone with the source: %v", err)
	}
	// A renamed text file is refused and leaves nothing behind.
	fake := filepath.Join(src, "icon.png")
	os.WriteFile(fake, []byte("not an image"), 0600)
	if _, err := ImportWorkspaceIconFile(store, "ws-1", fake); IconRefusalReason(err) != IconRefusedType {
		t.Fatalf("renamed file: %v", err)
	}
	entries, _ := os.ReadDir(store)
	if len(entries) != 1 {
		t.Fatalf("store holds %d files, want 1", len(entries))
	}
	if _, err := StoreWorkspaceIcon(store, "../escape", data, WorkspaceIconPng); err == nil {
		t.Fatalf("a workspace id with a path was accepted")
	}
}

func TestWorkspaceIconNames(t *testing.T) {
	good := WorkspaceIconFileName("6b0f6a0e-2b6f-4b8e-9a37-1c1d2f3e4a5b", []byte("x"), WorkspaceIconSvg)
	if !CheckWorkspaceIconName(good) {
		t.Fatalf("%q refused", good)
	}
	for _, bad := range []string{"", "../x-0123456789ab.png", "/etc/passwd", "ws-0123456789ab.gif", "ws-0123456789AB.png", "ws-0123456789ab.png/..", "a/b-0123456789ab.png"} {
		if CheckWorkspaceIconName(bad) {
			t.Fatalf("%q accepted", bad)
		}
	}
	dir := t.TempDir()
	outside := filepath.Join(dir, "keep.txt")
	os.WriteFile(outside, []byte("x"), 0600)
	if err := RemoveWorkspaceIconFile(dir, "keep.txt"); err != nil || !fileExists(outside) {
		t.Fatalf("a file MoltenTerm did not name was removed")
	}
	if err := RemoveWorkspaceIconFile(dir, "ws-0123456789ab.png"); err != nil {
		t.Fatalf("removing a missing file: %v", err)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestWorkspaceIconOwner(t *testing.T) {
	if !CheckWorkspaceIconOwner("a-0123456789ab.png", "a") {
		t.Fatalf("own file refused")
	}
	for _, name := range []string{"a-b-0123456789ab.png", "b-0123456789ab.png", "a-0123456789ab.gif", ""} {
		if CheckWorkspaceIconOwner(name, "a") {
			t.Fatalf("%q accepted as workspace a's", name)
		}
	}
	dir := t.TempDir()
	for _, name := range []string{"a-0123456789ab.png", "a-ffffffffffff.svg", "a-b-0123456789ab.png", "b-0123456789ab.png"} {
		os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600)
	}
	removed := RemoveWorkspaceIconFiles(dir, "a")
	if len(removed) != 2 || !fileExists(filepath.Join(dir, "a-b-0123456789ab.png")) || !fileExists(filepath.Join(dir, "b-0123456789ab.png")) {
		t.Fatalf("removed %v", removed)
	}
	if RemoveWorkspaceIconFiles(dir, "../x") != nil {
		t.Fatalf("a path accepted as a workspace id")
	}
}

func TestSweepWorkspaceIcons(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a-0123456789ab.png", "b-0123456789ab.svg", ".import-123", "notes.txt"} {
		os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600)
	}
	removed := SweepWorkspaceIcons(dir, map[string]bool{"a-0123456789ab.png": true})
	if len(removed) != 2 {
		t.Fatalf("removed %v", removed)
	}
	for name, want := range map[string]bool{"a-0123456789ab.png": true, "b-0123456789ab.svg": false, ".import-123": false, "notes.txt": true} {
		if fileExists(filepath.Join(dir, name)) != want {
			t.Fatalf("%s: exists %v, want %v", name, !want, want)
		}
	}
	if SweepWorkspaceIcons(filepath.Join(dir, "missing"), nil) != nil {
		t.Fatalf("sweeping a missing folder")
	}
}

func TestResolveWorkspaceIcon(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "ws-0123456789ab.png"), []byte("x"), 0600)
	cases := []struct {
		name string
		meta map[string]any
		kind string
		path string
	}{
		{"built-in", map[string]any{}, WorkspaceIconKindBuiltin, ""},
		{"logo", map[string]any{ProjectLogoMetaKey: "/p/logo.svg"}, WorkspaceIconKindLogo, "/p/logo.svg"},
		{"imported over logo", map[string]any{WorkspaceIconMetaKey: "ws-0123456789ab.png", ProjectLogoMetaKey: "/p/logo.svg"}, WorkspaceIconKindImported, filepath.Join(dir, "ws-0123456789ab.png")},
		{"missing file falls back to the logo", map[string]any{WorkspaceIconMetaKey: "ws-ffffffffffff.png", ProjectLogoMetaKey: "/p/logo.svg"}, WorkspaceIconKindLogo, "/p/logo.svg"},
		{"missing file falls back to built-in", map[string]any{WorkspaceIconMetaKey: "ws-ffffffffffff.png"}, WorkspaceIconKindBuiltin, ""},
		{"a path in the meta is ignored", map[string]any{WorkspaceIconMetaKey: "/etc/passwd"}, WorkspaceIconKindBuiltin, ""},
		{"a non-string value is ignored", map[string]any{WorkspaceIconMetaKey: 12, ProjectLogoMetaKey: true}, WorkspaceIconKindBuiltin, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveWorkspaceIcon(tc.meta, "rocket", "#ff0000", dir)
			if got.Kind != tc.kind || got.Path != tc.path || got.Icon != "rocket" || got.Color != "#ff0000" {
				t.Fatalf("got %+v, want %s %q", got, tc.kind, tc.path)
			}
		})
	}
}

func solidAt(img image.Image, x int, y int) color.NRGBA {
	return color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
}

func decodeStored(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("stored bytes are not a PNG: %v", err)
	}
	return img
}

// Left and right thirds are red, the centre square is green: a cover crop keeps only the green.
func makeBanner(t *testing.T, w int, h int, centre color.NRGBA, kind string) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	side := min(w, h)
	left, top := (w-side)/2, (h-side)/2
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if x >= left && x < left+side && y >= top && y < top+side {
				img.SetNRGBA(x, y, centre)
				continue
			}
			img.SetNRGBA(x, y, color.NRGBA{R: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	switch kind {
	case WorkspaceIconJpeg:
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
			t.Fatal(err)
		}
	default:
		if err := png.Encode(&buf, img); err != nil {
			t.Fatal(err)
		}
	}
	return buf.Bytes()
}

func TestWorkspaceIconRasterCopy(t *testing.T) {
	green := color.NRGBA{G: 200, A: 255}
	cases := []struct {
		name string
		data []byte
		side int
	}{
		{"large wide png is cropped and scaled to 256", makeBanner(t, 900, 400, green, WorkspaceIconPng), 256},
		{"large tall png", makeBanner(t, 300, 700, green, WorkspaceIconPng), 256},
		{"large jpeg", makeBanner(t, 800, 500, green, WorkspaceIconJpeg), 256},
		{"exactly 256 square", makeBanner(t, 256, 256, green, WorkspaceIconPng), 256},
		{"small png is not scaled up", makeBanner(t, 64, 40, green, WorkspaceIconPng), 40},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stored, ext, err := PrepareWorkspaceIcon(tc.data)
			if err != nil || ext != WorkspaceIconPng {
				t.Fatalf("ext %q err %v", ext, err)
			}
			img := decodeStored(t, stored)
			if b := img.Bounds(); b.Dx() != tc.side || b.Dy() != tc.side {
				t.Fatalf("stored %dx%d, want %dx%d", b.Dx(), b.Dy(), tc.side, tc.side)
			}
			for _, pt := range [][2]int{{1, 1}, {tc.side - 2, 1}, {tc.side / 2, tc.side / 2}, {1, tc.side - 2}} {
				got := solidAt(img, pt[0], pt[1])
				if got.R > 40 || got.G < 150 {
					t.Fatalf("pixel %v is %+v, want the green centre", pt, got)
				}
			}
		})
	}
}

func TestWorkspaceIconRasterKeepsAlpha(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 600, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 600; x++ {
			if x < 300 {
				src.SetNRGBA(x, y, color.NRGBA{B: 255, A: 255})
			}
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, src)
	stored, _, err := PrepareWorkspaceIcon(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	img := decodeStored(t, stored)
	if got := solidAt(img, 20, 128); got.A != 255 || got.B < 250 {
		t.Fatalf("opaque side is %+v", got)
	}
	if got := solidAt(img, 235, 128); got.A != 0 {
		t.Fatalf("transparent side is %+v", got)
	}
}

func TestWorkspaceIconWebp(t *testing.T) {
	// 300 x 200 lossless: magenta sides, green 200 x 200 centre.
	real, err := base64.StdEncoding.DecodeString("UklGRjIAAABXRUJQVlA4TCYAAAAvK8ExAA8wyPu///MfHjCQtk3h/h0fImMR/Y+qegAAgKuq+T/FAA==")
	if err != nil {
		t.Fatal(err)
	}
	stored, ext, err := PrepareWorkspaceIcon(real)
	if err != nil || ext != WorkspaceIconPng {
		t.Fatalf("a decodable WebP: ext %q err %v", ext, err)
	}
	img := decodeStored(t, stored)
	if b := img.Bounds(); b.Dx() != 200 || b.Dy() != 200 {
		t.Fatalf("stored %v, want 200x200", b)
	}
	if got := solidAt(img, 2, 100); got.G < 190 || got.R > 10 {
		t.Fatalf("edge pixel %+v, want the green centre", got)
	}
	// Structurally valid but not decodable here (the decoder has no animation): kept as it is.
	undecodable := makeWebp(128, 64)
	kept, ext, err := PrepareWorkspaceIcon(undecodable)
	if err != nil || ext != WorkspaceIconWebp || !bytes.Equal(kept, undecodable) {
		t.Fatalf("an undecodable WebP: ext %q err %v", ext, err)
	}
}

func TestWorkspaceIconIcoKeptAsIs(t *testing.T) {
	ico := makeIco(makePng(t, 32, 32))
	stored, ext, err := PrepareWorkspaceIcon(ico)
	if err != nil || ext != WorkspaceIconIco || !bytes.Equal(stored, ico) {
		t.Fatalf("ico: ext %q err %v", ext, err)
	}
}

func TestWorkspaceIconRasterIsStable(t *testing.T) {
	data := makeBanner(t, 500, 300, color.NRGBA{G: 200, A: 255}, WorkspaceIconPng)
	first, _, _ := PrepareWorkspaceIcon(data)
	second, _, _ := PrepareWorkspaceIcon(data)
	if WorkspaceIconFileName("ws-1", first, "png") != WorkspaceIconFileName("ws-1", second, "png") {
		t.Fatalf("the same image gave two names")
	}
	if len(first) >= len(data) && len(data) > 2000 {
		t.Fatalf("the copy (%d bytes) is not smaller than the source (%d)", len(first), len(data))
	}
}

// An EXIF APP1 segment holding only the orientation tag, in the given byte order.
func makeExifSegment(orientation uint16, bigEndian bool) []byte {
	var order binary.AppendByteOrder = binary.LittleEndian
	head := "II"
	if bigEndian {
		order = binary.BigEndian
		head = "MM"
	}
	tiff := []byte(head)
	tiff = order.AppendUint16(tiff, 42)
	tiff = order.AppendUint32(tiff, 8)
	tiff = order.AppendUint16(tiff, 1)
	tiff = order.AppendUint16(tiff, exifOrientationTag)
	tiff = order.AppendUint16(tiff, 3)
	tiff = order.AppendUint32(tiff, 1)
	tiff = order.AppendUint16(tiff, orientation)
	tiff = append(tiff, 0, 0)
	tiff = order.AppendUint32(tiff, 0)
	body := append([]byte("Exif\x00\x00"), tiff...)
	segment := []byte{0xFF, 0xE1}
	segment = binary.BigEndian.AppendUint16(segment, uint16(len(body)+2))
	return append(segment, body...)
}

func withExif(jpegData []byte, segment []byte) []byte {
	out := append([]byte{}, jpegData[:2]...)
	out = append(out, segment...)
	return append(out, jpegData[2:]...)
}

// A 300 x 300 JPEG whose top-left quadrant is red and the rest blue.
func makeQuadrantJpeg(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 300, 300))
	for y := 0; y < 300; y++ {
		for x := 0; x < 300; x++ {
			if x < 150 && y < 150 {
				img.SetNRGBA(x, y, color.NRGBA{R: 255, A: 255})
			} else {
				img.SetNRGBA(x, y, color.NRGBA{B: 255, A: 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The corner (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right) holding the red quadrant.
func redCorner(t *testing.T, stored []byte) int {
	t.Helper()
	img := decodeStored(t, stored)
	corners := [][2]int{{40, 40}, {215, 40}, {40, 215}, {215, 215}}
	found := -1
	for i, pt := range corners {
		if got := solidAt(img, pt[0], pt[1]); got.R > 200 && got.B < 80 {
			if found != -1 {
				t.Fatalf("two red corners")
			}
			found = i
		}
	}
	return found
}

func TestWorkspaceIconJpegOrientation(t *testing.T) {
	base := makeQuadrantJpeg(t)
	cases := []struct {
		name       string
		data       []byte
		wantCorner int
	}{
		{"no exif", base, 0},
		{"orientation 1", withExif(base, makeExifSegment(1, false)), 0},
		{"orientation 3", withExif(base, makeExifSegment(3, false)), 3},
		{"orientation 6", withExif(base, makeExifSegment(6, false)), 1},
		{"orientation 6 big endian", withExif(base, makeExifSegment(6, true)), 1},
		{"orientation 8", withExif(base, makeExifSegment(8, false)), 2},
		{"orientation 2", withExif(base, makeExifSegment(2, false)), 1},
		{"orientation 4", withExif(base, makeExifSegment(4, false)), 2},
		{"orientation 5", withExif(base, makeExifSegment(5, false)), 0},
		{"orientation 7", withExif(base, makeExifSegment(7, false)), 3},
		{"orientation 9 is ignored", withExif(base, makeExifSegment(9, false)), 0},
		{"truncated exif segment", withExif(base, func() []byte {
			seg := makeExifSegment(6, false)[:14]
			binary.BigEndian.PutUint16(seg[2:4], uint16(len(seg)-2))
			return seg
		}()), 0},
		{"exif segment longer than the file", append(append([]byte{}, base[:2]...), 0xFF, 0xE1, 0xFF, 0xFF, 'E', 'x'), 0},
		{"exif without a tiff header", withExif(base, []byte{0xFF, 0xE1, 0x00, 0x0A, 'E', 'x', 'i', 'f', 0, 0, 'X', 'X', 0, 0}), 0},
		{"ifd offset outside the segment", withExif(base, func() []byte {
			seg := makeExifSegment(6, false)
			seg[10+4] = 0xFF
			return seg
		}()), 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := tc.data
			if strings.HasPrefix(tc.name, "exif segment longer") {
				data = append(data, base[2:]...)
			}
			stored, _, err := PrepareWorkspaceIcon(data)
			if tc.name == "exif segment longer than the file" {
				if err == nil {
					t.Fatalf("a broken JPEG was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := redCorner(t, stored); got != tc.wantCorner {
				t.Fatalf("red corner %d, want %d", got, tc.wantCorner)
			}
		})
	}
}
