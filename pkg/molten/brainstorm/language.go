// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"strings"
	"unicode"
)

// The language of a brainstorm (DS-BOSS-010, #2250): brainstorm.json's `language`, a BCP-47 tag, and the one its brief
// is written in when Brokk names none. It is read from what the developer wrote, in the two languages MoltenTerm ships
// (their little words: an article, a pronoun, a preposition), and is otherwise the interface's. A guess needs a clear
// lead: a message too short or mixed says nothing, and the interface's language stands.

const (
	FallbackLanguage = "en"

	// minLanguageWords: how many little words of one language the developer's messages hold before they say it.
	minLanguageWords = 3
)

var languageWords = map[string]map[string]bool{
	"en": wordSet("the", "and", "is", "are", "was", "to", "of", "for", "it", "that", "with", "what", "how", "you", "this",
		"my", "we", "an", "in", "be", "not", "which", "who", "would", "should", "want", "they", "them", "i", "t", "ll", "ve"),
	"fr": wordSet("le", "la", "les", "des", "et", "est", "sont", "un", "une", "pour", "que", "qui", "pas", "je", "vous",
		"nous", "du", "ce", "cette", "avec", "dans", "sur", "mon", "ma", "mes", "au", "aux", "il", "elle", "ne", "ça",
		"quel", "quelle", "j", "l", "d", "qu", "c"),
}

func wordSet(words ...string) map[string]bool {
	rtn := make(map[string]bool, len(words))
	for _, w := range words {
		rtn[w] = true
	}
	return rtn
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// DetectLanguage is the language the texts are written in, "en" or "fr", or "" when they do not say it clearly.
func DetectLanguage(texts []string) string {
	counts := map[string]int{}
	for _, text := range texts {
		for _, word := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !isWordRune(r) }) {
			for lang, words := range languageWords {
				if words[word] {
					counts[lang]++
				}
			}
		}
	}
	en, fr := counts["en"], counts["fr"]
	switch {
	case en >= minLanguageWords && en*2 > fr*3:
		return "en"
	case fr >= minLanguageWords && fr*2 > en*3:
		return "fr"
	}
	return ""
}

// languageOf is a brainstorm's language: what the developer's messages say, else the interface's, else English.
func languageOf(turns []Turn, appLanguage string) string {
	texts := []string{}
	for _, turn := range turns {
		if turn.Role == RoleYou {
			texts = append(texts, turn.Text)
		}
	}
	if lang := DetectLanguage(texts); lang != "" {
		return lang
	}
	if lang := CleanLanguage(strings.ToLower(appLanguage)); lang != "" {
		return lang
	}
	return FallbackLanguage
}
