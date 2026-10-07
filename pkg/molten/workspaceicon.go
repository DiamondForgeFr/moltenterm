// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// An image imported as a workspace's icon (FR-SHELL-031, DS-SHELL-038/039). The image is untrusted (NFR-SHELL-015): it
// is size and type checked from its content, an SVG is rebuilt from an allow-list, and the copy lives in the data
// folder under a name MoltenTerm makes, so the user's file is only ever read and never served.

// must match the keys in frontend/moltenterm-shell/workspace-icon-model.ts
const (
	WorkspaceIconMetaKey  = "molten:workspaceicon"
	WorkspaceIconsDirName = "workspace-icons"
)

const (
	MaxWorkspaceIconBytes = 1024 * 1024
	MaxWorkspaceIconSide  = 4096
	workspaceIconHashLen  = 12
	workspaceIconTempGlob = ".import-*"
	// Real icons hold a handful of sizes; an entry is at most 256 px a side.
	maxIcoEntries = 64
	maxIcoSide    = 256
)

const (
	WorkspaceIconPng  = "png"
	WorkspaceIconJpeg = "jpg"
	WorkspaceIconWebp = "webp"
	WorkspaceIconSvg  = "svg"
	WorkspaceIconIco  = "ico"
)

// The one-line reasons the edit sheet shows.
const (
	IconRefusedTooLarge   = "Too large: 1 MB at most"
	IconRefusedType       = "Not a PNG, JPG, WebP, SVG or ICO image"
	IconRefusedPixels     = "Too large: 4096 × 4096 pixels at most"
	IconRefusedUnreadable = "The image could not be read"
	IconRefusedSvgDoctype = "An SVG with a DOCTYPE or entities is not accepted"
)

const (
	WorkspaceIconKindImported = "imported"
	WorkspaceIconKindLogo     = "logo"
	WorkspaceIconKindBuiltin  = "builtin"
)

// A refused image: Reason is shown to the user as it is.
type IconRefusal struct {
	Reason string
}

func (r *IconRefusal) Error() string {
	return r.Reason
}

func refuseIcon(reason string) error {
	return &IconRefusal{Reason: reason}
}

// The refusal's reason, or "" when err is not a refusal.
func IconRefusalReason(err error) string {
	var refusal *IconRefusal
	if errors.As(err, &refusal) {
		return refusal.Reason
	}
	return ""
}

var workspaceIconNameRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}-[0-9a-f]{12}\.(png|jpg|webp|svg|ico)$`)
var workspaceIdRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// Only names MoltenTerm made: a meta value can never lead a read or a delete outside the icons folder.
func CheckWorkspaceIconName(name string) bool {
	return workspaceIconNameRe.MatchString(name)
}

func WorkspaceIconsDir() string {
	return filepath.Join(wavebase.GetWaveDataDir(), WorkspaceIconsDirName)
}

// <workspaceid>-<first 12 hex of the sha256 of the stored bytes>.<ext>: the user's file name never appears in it.
func WorkspaceIconFileName(workspaceId string, data []byte, ext string) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%s-%s.%s", workspaceId, hex.EncodeToString(sum[:])[:workspaceIconHashLen], ext)
}

// The source is checked before anything is read, and read only up to one byte past the limit: a 3 GB file, a FIFO or
// a device never gets read in full. It is opened non-blocking and checked through the open file, so a FIFO swapped in
// after a check can neither block the open nor be read.
func ReadWorkspaceIconSource(path string) ([]byte, error) {
	if path == "" {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	if info.Size() > MaxWorkspaceIconBytes {
		return nil, refuseIcon(IconRefusedTooLarge)
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxWorkspaceIconBytes+1))
	if err != nil {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	if len(data) > MaxWorkspaceIconBytes {
		return nil, refuseIcon(IconRefusedTooLarge)
	}
	if len(data) == 0 {
		return nil, refuseIcon(IconRefusedUnreadable)
	}
	return data, nil
}

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// The type, judged from the content only.
func DetectWorkspaceIconType(data []byte) string {
	switch {
	case bytes.HasPrefix(data, pngSignature):
		return WorkspaceIconPng
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return WorkspaceIconJpeg
	case len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return WorkspaceIconWebp
	case len(data) >= 6 && data[0] == 0 && data[1] == 0 && data[2] == 1 && data[3] == 0:
		return WorkspaceIconIco
	case looksLikeXml(data):
		return WorkspaceIconSvg
	}
	return ""
}

func looksLikeXml(data []byte) bool {
	trimmed := bytes.TrimLeft(bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF")), " \t\r\n")
	return bytes.HasPrefix(trimmed, []byte("<"))
}

func checkIconSide(width int, height int) error {
	if width <= 0 || height <= 0 {
		return refuseIcon(IconRefusedUnreadable)
	}
	if width > MaxWorkspaceIconSide || height > MaxWorkspaceIconSide {
		return refuseIcon(IconRefusedPixels)
	}
	return nil
}

// The dimensions come from the header and are checked before the image is decoded, so a small file declaring a huge
// image is refused without allocating it.
func checkPng(data []byte) error {
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return refuseIcon(IconRefusedUnreadable)
	}
	if err := checkIconSide(cfg.Width, cfg.Height); err != nil {
		return err
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		return refuseIcon(IconRefusedUnreadable)
	}
	return nil
}

func checkJpeg(data []byte) error {
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return refuseIcon(IconRefusedUnreadable)
	}
	if err := checkIconSide(cfg.Width, cfg.Height); err != nil {
		return err
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		return refuseIcon(IconRefusedUnreadable)
	}
	return nil
}

func le24(b []byte) int {
	return int(b[0]) | int(b[1])<<8 | int(b[2])<<16
}

// The standard library has no WebP decoder: the RIFF container is checked chunk by chunk (sizes inside the file, an
// image chunk present) and the canvas size is read from the first chunk. Chromium decodes it for display; a frame
// it cannot decode falls back to the next icon (FR-SHELL-031 AC9).
func checkWebp(data []byte) error {
	riffSize := int(binary.LittleEndian.Uint32(data[4:8]))
	end := riffSize + 8
	if riffSize < 4 || end > len(data) || len(data)-end > 1 {
		return refuseIcon(IconRefusedUnreadable)
	}
	width, height := 0, 0
	hasImage := false
	first := true
	for pos := 12; pos < end; {
		if pos+8 > end {
			return refuseIcon(IconRefusedUnreadable)
		}
		fourcc := string(data[pos : pos+4])
		size := int(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		body := pos + 8
		if size < 0 || body+size > end {
			return refuseIcon(IconRefusedUnreadable)
		}
		chunk := data[body : body+size]
		switch fourcc {
		case "VP8X":
			if !first || size < 10 {
				return refuseIcon(IconRefusedUnreadable)
			}
			width, height = le24(chunk[4:7])+1, le24(chunk[7:10])+1
		case "VP8 ":
			if size < 10 || chunk[3] != 0x9d || chunk[4] != 0x01 || chunk[5] != 0x2a {
				return refuseIcon(IconRefusedUnreadable)
			}
			if first {
				width = int(binary.LittleEndian.Uint16(chunk[6:8]) & 0x3fff)
				height = int(binary.LittleEndian.Uint16(chunk[8:10]) & 0x3fff)
			}
			hasImage = true
		case "VP8L":
			if size < 5 || chunk[0] != 0x2f {
				return refuseIcon(IconRefusedUnreadable)
			}
			if first {
				bits := binary.LittleEndian.Uint32(chunk[1:5])
				width = int(bits&0x3fff) + 1
				height = int((bits>>14)&0x3fff) + 1
			}
			hasImage = true
		case "ANMF":
			hasImage = true
		default:
			if first {
				return refuseIcon(IconRefusedUnreadable)
			}
		}
		first = false
		pos = body + size + size%2
	}
	if !hasImage {
		return refuseIcon(IconRefusedUnreadable)
	}
	return checkIconSide(width, height)
}

// An ICO is a directory of images: every entry must lie inside the file without overlapping another, so a crafted
// directory cannot make one large image be decoded thousands of times. Entries are at most 256 px a side, which keeps
// each PNG decode small; BMP entries must carry a sane header.
func checkIco(data []byte) error {
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	dirEnd := 6 + 16*count
	if count == 0 || count > maxIcoEntries || dirEnd > len(data) {
		return refuseIcon(IconRefusedUnreadable)
	}
	type span struct{ start, end int }
	spans := make([]span, 0, count)
	for i := 0; i < count; i++ {
		entry := data[6+16*i : 6+16*(i+1)]
		size := int(binary.LittleEndian.Uint32(entry[8:12]))
		offset := int(binary.LittleEndian.Uint32(entry[12:16]))
		if size <= 0 || offset < dirEnd || offset > len(data) || size > len(data)-offset {
			return refuseIcon(IconRefusedUnreadable)
		}
		for _, s := range spans {
			if offset < s.end && s.start < offset+size {
				return refuseIcon(IconRefusedUnreadable)
			}
		}
		spans = append(spans, span{offset, offset + size})
	}
	for _, s := range spans {
		image := data[s.start:s.end]
		if bytes.HasPrefix(image, pngSignature) {
			if err := checkIcoPng(image); err != nil {
				return err
			}
			continue
		}
		if err := checkIcoBitmap(image); err != nil {
			return err
		}
	}
	return nil
}

func checkIcoPng(image []byte) error {
	cfg, err := png.DecodeConfig(bytes.NewReader(image))
	if err != nil {
		return refuseIcon(IconRefusedUnreadable)
	}
	if cfg.Width > maxIcoSide || cfg.Height > maxIcoSide {
		return refuseIcon(IconRefusedUnreadable)
	}
	return checkPng(image)
}

func checkIcoBitmap(image []byte) error {
	if len(image) < 40 || binary.LittleEndian.Uint32(image[0:4]) < 40 {
		return refuseIcon(IconRefusedUnreadable)
	}
	width := int(int32(binary.LittleEndian.Uint32(image[4:8])))
	// The height covers the image and its mask.
	height := int(int32(binary.LittleEndian.Uint32(image[8:12]))) / 2
	if height < 0 {
		height = -height
	}
	if width > maxIcoSide || height > maxIcoSide {
		return refuseIcon(IconRefusedUnreadable)
	}
	return checkIconSide(width, height)
}

// Returns the bytes to store and their extension, or a refusal.
func PrepareWorkspaceIcon(data []byte) ([]byte, string, error) {
	if len(data) > MaxWorkspaceIconBytes {
		return nil, "", refuseIcon(IconRefusedTooLarge)
	}
	kind := DetectWorkspaceIconType(data)
	var err error
	switch kind {
	case WorkspaceIconPng:
		err = checkPng(data)
	case WorkspaceIconJpeg:
		err = checkJpeg(data)
	case WorkspaceIconWebp:
		err = checkWebp(data)
	case WorkspaceIconIco:
		err = checkIco(data)
	case WorkspaceIconSvg:
		data, err = SanitizeSvg(data)
	default:
		err = refuseIcon(IconRefusedType)
	}
	if err != nil {
		return nil, "", err
	}
	return data, kind, nil
}

// Written next to its final name and renamed, so a reader never sees half a file.
func StoreWorkspaceIcon(dir string, workspaceId string, data []byte, ext string) (string, error) {
	if !workspaceIdRe.MatchString(workspaceId) {
		return "", fmt.Errorf("invalid workspace id %q", workspaceId)
	}
	name := WorkspaceIconFileName(workspaceId, data, ext)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("error creating %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, workspaceIconTempGlob)
	if err != nil {
		return "", fmt.Errorf("error creating the icon file: %w", err)
	}
	tmpName := tmp.Name()
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("error writing the icon file: %v", errors.Join(writeErr, closeErr))
	}
	if err := os.Rename(tmpName, filepath.Join(dir, name)); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("error storing the icon file: %w", err)
	}
	return name, nil
}

// Reads, checks and stores the image at path; returns the stored name. A refused image leaves nothing behind.
func ImportWorkspaceIconFile(dir string, workspaceId string, path string) (string, error) {
	data, err := ReadWorkspaceIconSource(path)
	if err != nil {
		return "", err
	}
	stored, ext, err := PrepareWorkspaceIcon(data)
	if err != nil {
		return "", err
	}
	return StoreWorkspaceIcon(dir, workspaceId, stored, ext)
}

// A name that is not one MoltenTerm made is left alone.
func RemoveWorkspaceIconFile(dir string, name string) error {
	if !CheckWorkspaceIconName(name) {
		return nil
	}
	err := os.Remove(filepath.Join(dir, name))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Every stored copy of one workspace: a delete also catches a copy an import wrote while the workspace was going.
func RemoveWorkspaceIconFiles(dir string, workspaceId string) []string {
	if !workspaceIdRe.MatchString(workspaceId) {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var removed []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !CheckWorkspaceIconOwner(name, workspaceId) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err == nil {
			removed = append(removed, name)
		}
	}
	return removed
}

// A stored name belongs to the workspace it starts with: a meta value copied from another workspace (through the
// generic meta call) never deletes that workspace's file. The length check keeps workspace "a" from owning the files
// of a workspace "a-b".
func CheckWorkspaceIconOwner(name string, workspaceId string) bool {
	return CheckWorkspaceIconName(name) &&
		strings.HasPrefix(name, workspaceId+"-") &&
		len(name) == len(workspaceId)+1+workspaceIconHashLen+len(filepath.Ext(name))
}

// Removes the stored copies no workspace references, and imports interrupted half way. Other files are left alone.
func SweepWorkspaceIcons(dir string, referenced map[string]bool) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var removed []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() {
			continue
		}
		stale := strings.HasPrefix(name, ".import-") || (CheckWorkspaceIconName(name) && !referenced[name])
		if !stale {
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err == nil {
			removed = append(removed, name)
		}
	}
	return removed
}

type ResolvedWorkspaceIcon struct {
	Kind  string
	Path  string
	Icon  string
	Color string
}

// The same order as resolveWorkspaceIcon in frontend/moltenterm-shell/workspace-icon-model.ts (DS-SHELL-037): the
// imported image when its file is there, then the project logo, then the built-in icon and colour.
func ResolveWorkspaceIcon(meta map[string]any, icon string, color string, iconsDir string) ResolvedWorkspaceIcon {
	rtn := ResolvedWorkspaceIcon{Kind: WorkspaceIconKindBuiltin, Icon: icon, Color: color}
	name, _ := meta[WorkspaceIconMetaKey].(string)
	if CheckWorkspaceIconName(name) {
		path := filepath.Join(iconsDir, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			rtn.Kind = WorkspaceIconKindImported
			rtn.Path = path
			return rtn
		}
	}
	logo, _ := meta[ProjectLogoMetaKey].(string)
	if logo != "" {
		rtn.Kind = WorkspaceIconKindLogo
		rtn.Path = logo
	}
	return rtn
}
