// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wconfig

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const braveSearchTemplate = "https://search.brave.com/search?q={query}"

// #2312: the recommended engine is the default one, so a new install and a user whose settings.json never named an
// engine search with Brave Search.
func TestSearchEngineIsBraveWhenTheUserNeverChose(t *testing.T) {
	for name, settings := range map[string]string{
		"no settings file":    "",
		"settings without it": `{"term:fontsize": 13}`,
		"empty settings file": `{}`,
	} {
		useConfigDir(t, settings)
		got := ReadFullConfig().Settings.WebDefaultSearch
		if got != braveSearchTemplate {
			t.Fatalf("%s: web:defaultsearch is %q, want %q", name, got, braveSearchTemplate)
		}
	}
}

// #2312: a value the user wrote is theirs, the former default (Google) included: it is read as it is and the file is
// never rewritten by the read.
func TestSearchEngineTheUserSetIsNeverReplaced(t *testing.T) {
	for _, own := range []string{
		"https://www.google.com/search?q={query}",
		"https://duckduckgo.com/?q={query}",
		"https://search.example.dev/find?query={query}",
	} {
		settings := `{"web:defaultsearch": "` + own + `", "term:fontsize": 13}`
		configDir := useConfigDir(t, settings)
		got := ReadFullConfig().Settings.WebDefaultSearch
		if got != own {
			t.Fatalf("web:defaultsearch is %q, want the user's %q", got, own)
		}
		after, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
		if err != nil {
			t.Fatal(err)
		}
		if string(after) != settings {
			t.Fatalf("reading the configuration rewrote settings.json: %s", after)
		}
	}
}

// #2312: the note about the default engine is remembered in a hidden boolean setting, one the screen can write.
func TestSearchEngineNoteIsABooleanSetting(t *testing.T) {
	ctype := getConfigKeyType("moltenterm:searchenginenote")
	if ctype == nil || ctype.Kind().String() != "bool" {
		t.Fatalf("moltenterm:searchenginenote has type %v, want a bool", ctype)
	}
	useConfigDir(t, `{}`)
	if err := SetBaseConfigValue(waveobj.MetaMapType{"moltenterm:searchenginenote": true}); err != nil {
		t.Fatalf("set: %v", err)
	}
	if !ReadFullConfig().Settings.MoltentermSearchEngineNote {
		t.Fatalf("the note's flag was not stored")
	}
	if got := ReadFullConfig().Settings.WebDefaultSearch; got != braveSearchTemplate {
		t.Fatalf("storing the flag changed the engine to %q", got)
	}
}
