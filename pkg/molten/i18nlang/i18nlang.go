// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package i18nlang resolves the interface language (app:language, FR-I18N-001) on the wavesrv side, with the rules of
// frontend/moltenterm-shell/i18n/i18n-core.ts: an explicit value wins, else the language MoltenTerm picked from the OS
// preferred languages. Electron main resolves that one with the shipped dictionaries (app.getPreferredSystemLanguages,
// matched on the primary subtag) and passes it in MOLTENTERM_SYSTEM_LANGUAGE, so adding a dictionary needs no Go
// change. Only the review session reads it (review:language's default, DS-I18N-006): the molten and wsh commands never
// translate their output (DS-I18N-007).
package i18nlang

import (
	"os"
	"strings"
)

const (
	SystemLanguageVarName = "MOLTENTERM_SYSTEM_LANGUAGE"
	SystemLanguage        = "system"
	FallbackLanguage      = "en"
)

// SystemLocale is the language Electron main resolved from the OS preferred languages, "" when absent.
func SystemLocale() string {
	return strings.ToLower(strings.TrimSpace(os.Getenv(SystemLanguageVarName)))
}

// Resolve is the interface language for an app:language value: the value when explicit, else systemLocale, else
// fallback() (which may answer ""), else English. An explicit value that names a language pack wavesrv does not know
// is kept: the review session can talk in it.
func Resolve(setting string, systemLocale string, fallback func() string) string {
	explicit := strings.ToLower(strings.TrimSpace(setting))
	if explicit != "" && explicit != SystemLanguage {
		return explicit
	}
	if systemLocale != "" {
		return systemLocale
	}
	if fallback != nil {
		if lang := fallback(); lang != "" {
			return lang
		}
	}
	return FallbackLanguage
}
