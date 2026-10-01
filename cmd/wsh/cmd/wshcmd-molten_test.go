// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

func TestFormatMoltenModListEmpty(t *testing.T) {
	out := formatMoltenModList(&MoltenModList{ModsDir: "/cfg/mods"})
	if out != "no mods in /cfg/mods\n" {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestFormatMoltenModListSafeMode(t *testing.T) {
	out := formatMoltenModList(&MoltenModList{ModsDir: "/cfg/mods", SafeMode: true})
	if !strings.HasPrefix(out, "safe mode: no mod is loaded\n") {
		t.Fatalf("safe mode not reported: %q", out)
	}
}

func TestFormatMoltenModListRows(t *testing.T) {
	list := &MoltenModList{
		ModsDir: "/cfg/mods",
		Mods: []MoltenModStatus{
			{Id: "good", Version: "1.0.0", State: "active", Commands: []string{"hello", "bye"}},
			{Id: "broken", Version: "0.1.0", State: "failed", Error: "activate: boom\nsecond line"},
			{Id: "future", State: "refused", Error: "apiVersion 2 is not supported; supported versions: 1"},
		},
	}
	lines := strings.Split(strings.TrimRight(formatMoltenModList(list), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected a header and 3 rows, got %d lines: %q", len(lines), lines)
	}
	if !strings.HasPrefix(lines[0], "ID") || !strings.Contains(lines[0], "ERROR") {
		t.Fatalf("unexpected header: %q", lines[0])
	}
	if !strings.Contains(lines[1], "active") || !strings.Contains(lines[1], "hello,bye") {
		t.Fatalf("unexpected active row: %q", lines[1])
	}
	if !strings.Contains(lines[2], "activate: boom second line") {
		t.Fatalf("error must stay on one line: %q", lines[2])
	}
	if !strings.Contains(lines[3], "refused") || !strings.Contains(lines[3], " - ") {
		t.Fatalf("unexpected refused row: %q", lines[3])
	}
}

// The renderer answers with the JSON of MoltenModList in frontend/molten/molten-host.ts; the field names must match.
func TestMoltenModListDecodesRendererAnswer(t *testing.T) {
	var answer any
	err := json.Unmarshal([]byte(`{"apiversions":[1],"safemode":false,"modsdir":"/cfg/mods",
		"mods":[{"id":"good","name":"Good","version":"1.0.0","path":"/cfg/mods/good","state":"active","commands":["hello"]}]}`), &answer)
	if err != nil {
		t.Fatal(err)
	}
	var list MoltenModList
	if err := utilfn.ReUnmarshal(&list, answer); err != nil {
		t.Fatal(err)
	}
	if len(list.ApiVersions) != 1 || list.ApiVersions[0] != 1 || list.ModsDir != "/cfg/mods" {
		t.Fatalf("unexpected list: %+v", list)
	}
	if len(list.Mods) != 1 || list.Mods[0].Name != "Good" || list.Mods[0].Commands[0] != "hello" {
		t.Fatalf("unexpected mods: %+v", list.Mods)
	}
}
