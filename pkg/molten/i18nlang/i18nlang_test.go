// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package i18nlang

import "testing"

func TestResolve(t *testing.T) {
	osDe := func() string { return "de" }
	cases := []struct {
		name     string
		setting  string
		system   string
		fallback func() string
		want     string
	}{
		{"explicit wins", "fr", "en", nil, "fr"},
		{"explicit any code", " ES ", "en", nil, "es"},
		{"system follows the OS", "system", "fr", osDe, "fr"},
		{"unset follows the OS", "", "fr", osDe, "fr"},
		{"without Electron's answer, the fallback", "", "", osDe, "de"},
		{"without anything, English", "", "", func() string { return "" }, "en"},
		{"no fallback", "system", "", nil, "en"},
	}
	for _, c := range cases {
		if got := Resolve(c.setting, c.system, c.fallback); got != c.want {
			t.Errorf("%s: Resolve(%q, %q) = %q, want %q", c.name, c.setting, c.system, got, c.want)
		}
	}
}

func TestSystemLocale(t *testing.T) {
	t.Setenv(SystemLanguageVarName, " FR ")
	if got := SystemLocale(); got != "fr" {
		t.Errorf("SystemLocale() = %q", got)
	}
	t.Setenv(SystemLanguageVarName, "")
	if got := SystemLocale(); got != "" {
		t.Errorf("SystemLocale() = %q, want empty", got)
	}
}
