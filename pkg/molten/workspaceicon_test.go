// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
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
		{"jpeg", makeJpeg(t, 40, 40), WorkspaceIconJpeg, ""},
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
	if err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("stored copy differs: %v", err)
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
