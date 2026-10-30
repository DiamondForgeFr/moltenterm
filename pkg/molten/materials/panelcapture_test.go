// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"os"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func jpegDataURL(t *testing.T, w int, h int) string {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

// #1560: a card's visual is the capture of the panel showing the material.
func TestPanelCaptureKeepsTheVisual(t *testing.T) {
	h := makeHarness(t)
	now := time.Now()
	h.r.store.now = func() time.Time { return now }
	file := h.write("plan.md", "# Plan")
	m, err := h.r.Add("block-1", "", file, "", "", false, molten.MaterialSourceDeclared)
	if err != nil {
		t.Fatal(err)
	}
	img, err := h.r.Add("block-1", "", h.writePng("shot.png", 800, 400), "", "", false, molten.MaterialSourceDeclared)
	if err != nil {
		t.Fatal(err)
	}
	store := h.r.store
	if n, err := store.PanelCapture(h.key(), nil, "/elsewhere/other.md", jpegDataURL(t, 900, 500)); err != nil || n != 0 {
		t.Fatalf("a panel showing nothing known keeps nothing: %d %v", n, err)
	}
	if _, err := store.PanelCapture(h.key(), nil, m.Original, "not an image"); err == nil {
		t.Errorf("a capture that is not a data URL is refused")
	}
	if n, err := store.PanelCapture(h.key(), nil, m.Original, jpegDataURL(t, 900, 500)); err != nil || n != 1 {
		t.Fatalf("kept: %d %v %+v", n, err, m)
	}
	var got, gotImg molten.Material
	for _, x := range h.list() {
		if x.Id == m.Id {
			got = x
		}
		if x.Id == img.Id {
			gotImg = x
		}
	}
	if !got.Thumb || !got.ThumbPanel || got.ThumbPath == "" || got.Updated != m.Updated {
		t.Fatalf("the material carries the capture without moving: %+v", got)
	}
	f, err := os.Open(got.ThumbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width > 640 || cfg.Height > 640 {
		t.Errorf("the copy is at most 640 px: %+v %v", cfg, err)
	}
	if gotImg.ThumbPanel {
		t.Errorf("an image keeps its own preview")
	}
	if n, _ := store.PanelCapture(h.key(), nil, m.Original, jpegDataURL(t, 900, 500)); n != 0 {
		t.Errorf("a capture right after another is not kept again")
	}
	now = now.Add(time.Minute)
	if n, _ := store.PanelCapture(h.key(), nil, m.Original, jpegDataURL(t, 900, 500)); n != 1 {
		t.Errorf("a later capture replaces it")
	}
}
