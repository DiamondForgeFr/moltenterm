// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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

// #2180: the number of visible panels "Do the same in every view" stores is a setting of the 360 view's group, so the
// developer can change it, or empty it, where the 360 view setting is.
func TestView360PlacesIsShownWithTheView360Setting(t *testing.T) {
	view, ok := Lookup("moltenterm:view360")
	if !ok {
		t.Fatalf("moltenterm:view360 has no entry")
	}
	places, ok := Lookup("moltenterm:view360places")
	if !ok || places.Hidden {
		t.Fatalf("moltenterm:view360places must be a shown setting")
	}
	if places.Section != view.Section || places.Group != view.Group {
		t.Errorf("moltenterm:view360places is in %s/%q, want %s/%q", places.Section, places.Group, view.Section, view.Group)
	}
	if places.Control != ControlSelect || places.UnsetLabel == "" {
		t.Errorf("moltenterm:view360places must be a select that can be empty, got %q %q", places.Control, places.UnsetLabel)
	}
	var values []string
	for _, o := range places.Options {
		values = append(values, o.Value)
	}
	if !slices.Equal(values, []string{"1", "2", "3"}) {
		t.Errorf("moltenterm:view360places offers %v, want 1, 2 and 3", values)
	}
	if places.Order != view.Order+1 {
		t.Errorf("moltenterm:view360places comes at %d, want right after the 360 view setting (%d)", places.Order, view.Order)
	}
}

func TestBossNameDefaultsToBrokk(t *testing.T) {
	s, ok := Lookup("boss:name")
	if !ok {
		t.Fatalf("boss:name has no entry")
	}
	if s.Default != "Brokk" {
		t.Errorf("boss:name defaults to %v, want Brokk", s.Default)
	}
}

// The table "Quand Brokk vient me chercher" (FR-BOSS-009, AC4, #2003) draws these keys: none stays hidden, and each
// carries the default the visit model falls back to (frontend/moltenterm-shell/boss/brokk-visit-events.ts).
func TestBrokkVisitKeysAreShown(t *testing.T) {
	defaults := map[string]any{
		"boss:visitsecurity": "vient",
		"boss:visitblocked":  "vient",
		"boss:visiterror":    "badge",
		"boss:visitci":       "badge",
		"boss:visitready":    "badge",
		"boss:visitfinished": "badge",
		"boss:visitdownload": "badge",
		"boss:visitupdate":   "badge",
		"boss:visitusage":    "rien",
		"boss:blockedmin":    5,
		"boss:quiet":         true,
		"boss:quietfrom":     "22:00",
		"boss:quietto":       "08:00",
	}
	for key, want := range defaults {
		s, ok := Lookup(key)
		if !ok || s.Hidden {
			t.Errorf("%s must be a shown setting", key)
			continue
		}
		if s.Section != SectionBoss || s.Group != BrokkTableGroup {
			t.Errorf("%s is in %s/%q, want the Brokk section's table", key, s.Section, s.Group)
		}
		if s.Default != want {
			t.Errorf("%s defaults to %v, want %v", key, s.Default, want)
		}
	}
	if s, ok := Lookup("boss:nevercome"); !ok || s.Hidden {
		t.Errorf("boss:nevercome must be a shown setting")
	}
}

// FR-BOSS-009, AC75 (#2203): Brokk's proximity is a choice on a scale that 1.1.0 extends, never a switch.
func TestBrokkProximityIsAChoiceThatCanGrow(t *testing.T) {
	s, ok := Lookup("boss:proximity")
	if !ok || s.Hidden {
		t.Fatalf("boss:proximity must be a shown setting")
	}
	if s.Section != SectionBoss || s.Group != "Avatar" {
		t.Errorf("boss:proximity is in %s/%q, want the Brokk section's Avatar group", s.Section, s.Group)
	}
	if s.Control != ControlSelect {
		t.Errorf("boss:proximity is a %s, want a select: 1.1.0 adds Close and Partner", s.Control)
	}
	if s.Default != "colleague" {
		t.Errorf("boss:proximity defaults to %v, want colleague", s.Default)
	}
	var values []string
	for _, option := range s.Options {
		values = append(values, option.Value)
	}
	if strings.Join(values, ",") != "discreet,colleague" {
		t.Errorf("boss:proximity offers %v, want discreet then colleague", values)
	}
	if v, ok := Lookup("boss:visitfinished"); !ok || !strings.Contains(v.Description, "never brings him") {
		t.Errorf("boss:visitfinished must say that a finished agent never brings him")
	}
}
