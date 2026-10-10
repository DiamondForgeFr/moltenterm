// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package settingsmeta

import (
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func settingsKeys() []string {
	var keys []string
	t := reflect.TypeOf(wconfig.SettingsType{})
	for i := 0; i < t.NumField(); i++ {
		name := strings.Split(t.Field(i).Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			keys = append(keys, name)
		}
	}
	return keys
}

// cmd/generateschema drops these from the schema (moltentermIsAISettingKey), so the screen never sees them.
func isAIKey(key string) bool {
	return strings.HasPrefix(key, "ai:") || strings.HasPrefix(key, "waveai:") || key == "app:hideaibutton"
}

func TestEverySettingIsMapped(t *testing.T) {
	for _, key := range settingsKeys() {
		if isAIKey(key) {
			continue
		}
		if _, ok := Lookup(key); !ok {
			t.Errorf("settings key %s has no entry: give it a section (or Hidden) in settingsmeta.go", key)
		}
	}
}

func TestEveryEntryIsASetting(t *testing.T) {
	keys := settingsKeys()
	seen := map[string]bool{}
	for _, s := range All() {
		if seen[s.Key] {
			t.Errorf("%s is listed twice", s.Key)
		}
		seen[s.Key] = true
		if !slices.Contains(keys, s.Key) {
			t.Errorf("%s is not a key of wconfig.SettingsType", s.Key)
		}
	}
}

func TestEntriesAreComplete(t *testing.T) {
	for _, s := range All() {
		if s.Hidden {
			continue
		}
		if !slices.Contains(Sections, s.Section) {
			t.Errorf("%s: unknown section %q", s.Key, s.Section)
		}
		if !slices.Contains(Controls, s.Control) {
			t.Errorf("%s: unknown control %q", s.Key, s.Control)
		}
		if s.Label == "" || s.Description == "" || s.Group == "" {
			t.Errorf("%s: a shown setting needs a group, a label and a description", s.Key)
		}
		if strings.Contains(s.Description, "\n") || len(s.Description) > 110 {
			t.Errorf("%s: the description must fit one line (%d characters)", s.Key, len(s.Description))
		}
		if (s.Control == ControlSelect || s.Control == ControlMulti) && len(s.Options) == 0 && s.OptionsFrom == "" {
			t.Errorf("%s: a %s needs options", s.Key, s.Control)
		}
		if (s.Control == ControlNumber || s.Control == ControlSlider) && s.Range == nil {
			t.Errorf("%s: a %s needs a range", s.Key, s.Control)
		}
	}
}

func TestOrderFollowsTheList(t *testing.T) {
	all := All()
	for i, s := range all {
		if s.Order != i {
			t.Fatalf("%s has order %d, want %d", s.Key, s.Order, i)
		}
	}
}
