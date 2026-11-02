// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The card's visual for a page or a link (#1560, DS-MAT-010): the latest still capture of the panel that shows it,
// kept with the material so it outlives the panel. The window sends the capture the 360 carpet already takes.

const (
	panelCaptureMaxData = 2 << 20
	// panelCaptureRefresh: a capture newer than this is kept; the carpet captures a resting panel every few seconds and
	// the card does not need each one.
	panelCaptureRefresh = 30 * time.Second
	dataURLMarker       = ";base64,"
)

func cleanPanelUrl(u string) string {
	if i := strings.Index(u, "#"); i >= 0 {
		u = u[:i]
	}
	return strings.TrimRight(u, "/")
}

func panelShows(m molten.Material, urls []string, file string, copyPath string) bool {
	if m.Link != "" {
		link := cleanPanelUrl(m.Link)
		for _, u := range urls {
			if u != "" && cleanPanelUrl(u) == link {
				return true
			}
		}
	}
	if file == "" {
		return false
	}
	file = strings.TrimRight(file, "/")
	for _, p := range []string{copyPath, m.Original} {
		if p != "" && strings.TrimRight(p, "/") == file {
			return true
		}
	}
	return false
}

func decodeDataURL(data string) ([]byte, error) {
	i := strings.Index(data, dataURLMarker)
	if i < 0 || len(data) > panelCaptureMaxData {
		return nil, errors.New("give the capture as a data URL")
	}
	return base64.StdEncoding.DecodeString(data[i+len(dataURLMarker):])
}

// PanelCapture keeps a panel's capture as the preview of the materials the panel shows. An image keeps its own preview
// and a preview that is not a capture is never replaced. It answers how many materials took it.
func (s *Store) PanelCapture(key string, urls []string, file string, dataURL string) (int, error) {
	raw, err := decodeDataURL(dataURL)
	if err != nil {
		return 0, err
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return 0, err
	}
	b := src.Bounds()
	if b.Dx() <= 0 || b.Dy() <= 0 || int64(b.Dx())*int64(b.Dy()) > thumbMaxPixels {
		return 0, errors.New("the capture has no usable size")
	}
	list, err := s.List(key)
	if err != nil {
		return 0, err
	}
	limits := DefaultLimits()
	var png []byte
	taken := 0
	now := s.now().UnixMilli()
	for _, m := range list {
		if m.Kind == molten.MaterialKindImage || (m.Thumb && !m.ThumbPanel) || !panelShows(m, urls, file, m.CopyPath) {
			continue
		}
		if m.ThumbPanel && now-m.ThumbAt < panelCaptureRefresh.Milliseconds() {
			continue
		}
		if png == nil {
			png = encodeThumb(src, limits.ThumbPx, limits.ThumbBytes)
			if png == nil {
				return 0, errors.New("the capture is too large to keep")
			}
		}
		id := m.Id
		dir := filepath.Join(s.drawerDir(m.Project), itemsDir, id)
		if err := ensureDir(dir); err != nil {
			return taken, err
		}
		if err := s.writeAtomic(filepath.Join(dir, thumbFile), png); err != nil {
			return taken, err
		}
		if _, err := s.updateWith(key, id, false, func(m *molten.Material) bool {
			m.Thumb, m.ThumbPanel, m.ThumbAt = true, true, now
			return true
		}); err != nil {
			return taken, err
		}
		taken++
	}
	return taken, nil
}
