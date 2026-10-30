// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"bytes"
	"html"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The automatic title (AC11 of FR-MAT-001), in this order: the publishing tool's; a page's <title>; a PDF's; a
// Markdown file's first heading; for an image or a video, the session's subject and the file name; otherwise the file
// name made readable.

const (
	titleReadBytes = 256 * 1024
	maxTitleRunes  = 120
)

var (
	htmlTitleRegex = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	mdHeadingRegex = regexp.MustCompile(`(?m)^#{1,6}[ \t]+(.+?)[ \t#]*$`)
	pdfTitleRegex  = regexp.MustCompile(`/Title\s*\(((?:\\.|[^\\)])*)\)`)
	nameSepRegex   = regexp.MustCompile(`[-_.\s]+`)
)

// AutoTitle finds a material's title; toolTitle and subject may be empty.
func AutoTitle(kind string, path string, link string, toolTitle string, subject string) string {
	if t := cleanTitle(toolTitle); t != "" {
		return t
	}
	if path != "" {
		switch kind {
		case molten.MaterialKindPage:
			if m := htmlTitleRegex.FindSubmatch(readHead(path)); m != nil {
				if t := cleanTitle(html.UnescapeString(string(m[1]))); t != "" {
					return t
				}
			}
		case molten.MaterialKindPdf:
			if m := pdfTitleRegex.FindSubmatch(readHead(path)); m != nil {
				if t := cleanTitle(strings.NewReplacer(`\(`, "(", `\)`, ")", `\\`, `\`).Replace(string(m[1]))); t != "" && utf8.ValidString(t) {
					return t
				}
			}
		case molten.MaterialKindText:
			if m := mdHeadingRegex.FindSubmatch(readHead(path)); m != nil {
				if t := cleanTitle(string(m[1])); t != "" {
					return t
				}
			}
		case molten.MaterialKindImage, molten.MaterialKindVideo:
			if s := cleanTitle(subject); s != "" {
				return cutRunes(readableName(path)+" · "+s, maxTitleRunes)
			}
		}
		if t := readableName(path); t != "" {
			return t
		}
	}
	if link != "" {
		return link
	}
	return "Material"
}

func readHead(path string) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	data, _ := io.ReadAll(io.LimitReader(f, titleReadBytes))
	return bytes.ToValidUTF8(data, nil)
}

// readableName: library-flash.mov becomes "Library flash".
func readableName(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	name = strings.TrimSpace(nameSepRegex.ReplaceAllString(name, " "))
	if name == "" {
		return ""
	}
	r, size := utf8.DecodeRuneInString(name)
	return cutRunes(string(unicode.ToUpper(r))+name[size:], maxTitleRunes)
}

func cleanTitle(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	return cutRunes(text, maxTitleRunes)
}

func cutRunes(text string, max int) string {
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	return string([]rune(text)[:max-1]) + "…"
}
