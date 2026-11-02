// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The kept types (AC12 of FR-MAT-001), by extension. Anything else is never a material: code, json, yaml, toml,
// archives, executables, databases.
var kindOfExt = map[string]string{
	".html": molten.MaterialKindPage, ".htm": molten.MaterialKindPage,
	".pdf": molten.MaterialKindPdf,
	".png": molten.MaterialKindImage, ".jpg": molten.MaterialKindImage, ".jpeg": molten.MaterialKindImage,
	".webp": molten.MaterialKindImage, ".gif": molten.MaterialKindImage, ".svg": molten.MaterialKindImage,
	".mp4": molten.MaterialKindVideo, ".mov": molten.MaterialKindVideo, ".webm": molten.MaterialKindVideo,
	".md": molten.MaterialKindText, ".markdown": molten.MaterialKindText, ".txt": molten.MaterialKindText,
	".docx": molten.MaterialKindDocument, ".pptx": molten.MaterialKindDocument, ".xlsx": molten.MaterialKindDocument,
}

// A page's linked files may also be what a page needs to show: its styles, scripts and fonts. They are never
// materials by themselves.
var linkedOnlyExt = map[string]bool{
	".css": true, ".js": true, ".mjs": true, ".woff": true, ".woff2": true, ".ttf": true, ".otf": true,
	".ico": true, ".avif": true, ".bmp": true, ".mp3": true, ".wav": true, ".ogg": true, ".vtt": true,
}

// Text is read by the secret detection before it is copied; other files are binary.
var textExt = map[string]bool{
	".html": true, ".htm": true, ".md": true, ".markdown": true, ".txt": true, ".svg": true,
	".css": true, ".js": true, ".mjs": true, ".vtt": true,
}

// KindOfPath is the kind of a file by its name, "" when it is not a kept type.
func KindOfPath(path string) string {
	return kindOfExt[strings.ToLower(filepath.Ext(path))]
}

func linkedAllowed(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return kindOfExt[ext] != "" || linkedOnlyExt[ext]
}

func isText(path string) bool {
	return textExt[strings.ToLower(filepath.Ext(path))]
}
