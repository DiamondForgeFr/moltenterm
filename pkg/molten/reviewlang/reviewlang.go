// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package reviewlang finds the language review comments are published in on GitHub (FR-REV-010, DS-REV-008): the
// project's declaration, else the developer's setting, else what the project's pull requests and README are written
// in, else English. It also normalizes the language names and codes the settings and the browser give.
package reviewlang

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// Where the publication language came from.
const (
	SourceProject  = "project"
	SourceSetting  = "setting"
	SourceDetected = "detected"
	SourceDefault  = "default"

	Default = "en"
)

const (
	// A text needs this many stopwords of one language, and twice those of the next one, to be detected as it.
	minHits   = 6
	leadRatio = 2
)

var names = map[string]string{
	"en": "English", "fr": "French", "de": "German", "es": "Spanish", "it": "Italian", "pt": "Portuguese", "nl": "Dutch",
}

var aliases = map[string]string{
	"english": "en", "anglais": "en",
	"french": "fr", "francais": "fr", "français": "fr",
	"german": "de", "deutsch": "de", "allemand": "de",
	"spanish": "es", "espanol": "es", "español": "es", "espagnol": "es",
	"italian": "it", "italiano": "it", "italien": "it",
	"portuguese": "pt", "portugues": "pt", "português": "pt", "portugais": "pt",
	"dutch": "nl", "nederlands": "nl", "néerlandais": "nl",
}

// Frequent short words, distinctive enough between these languages.
var stopwords = map[string][]string{
	"en": {"the", "and", "is", "are", "with", "this", "that", "for", "of", "to", "it", "when", "not", "be", "from", "which", "was", "on", "an", "by"},
	"fr": {"de", "le", "la", "les", "des", "est", "et", "une", "un", "du", "pour", "dans", "qui", "que", "pas", "sur", "avec", "ce", "au", "aux", "sont"},
	"de": {"der", "die", "das", "und", "ist", "nicht", "mit", "ein", "eine", "auf", "für", "den", "dem", "wird", "sich", "auch", "zu", "von", "im", "es"},
	"es": {"el", "los", "las", "es", "y", "una", "del", "para", "con", "que", "por", "se", "lo", "como", "más", "pero", "su", "al", "esta", "en"},
	"it": {"il", "lo", "gli", "le", "è", "e", "una", "della", "per", "con", "che", "non", "sono", "del", "di", "da", "nel", "alla", "questo", "come"},
	"pt": {"o", "os", "as", "é", "e", "uma", "do", "da", "para", "com", "que", "não", "são", "dos", "das", "em", "no", "na", "por", "mais"},
	"nl": {"de", "het", "een", "en", "is", "van", "niet", "met", "voor", "op", "dat", "die", "zijn", "te", "wordt", "ook", "aan", "bij", "naar", "als"},
}

var stopwordIndex = func() map[string][]string {
	rtn := map[string][]string{}
	for lang, words := range stopwords {
		for _, w := range words {
			rtn[w] = append(rtn[w], lang)
		}
	}
	return rtn
}()

// Normalize turns a language code or name into its short code: fr-FR, fr_FR.UTF-8, French and français are fr. An
// unknown name is kept lower case; "" stays "".
func Normalize(lang string) string {
	l := strings.ToLower(strings.TrimSpace(lang))
	if l == "" {
		return ""
	}
	if code, ok := aliases[l]; ok {
		return code
	}
	if i := strings.IndexAny(l, "-_."); i > 0 {
		l = l[:i]
	}
	return l
}

// Same tells whether two languages are the same; an unknown one ("") is taken as the other.
func Same(a string, b string) bool {
	na, nb := Normalize(a), Normalize(b)
	return na == "" || nb == "" || na == nb
}

// Name is the language's English name for the developer and the agent, else its code.
func Name(lang string) string {
	code := Normalize(lang)
	if name, ok := names[code]; ok {
		return name
	}
	return code
}

func words(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && r != '\''
	})
}

// stripCode drops fenced code blocks and inline code: identifiers would count as English.
func stripCode(text string) string {
	var b strings.Builder
	inFence := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		parts := strings.Split(line, "`")
		for i, p := range parts {
			if i%2 == 0 {
				b.WriteString(p)
				b.WriteString(" ")
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

// Detect returns the language most of the texts are written in, "" when they say too little to tell.
func Detect(texts ...string) string {
	hits := map[string]int{}
	for _, text := range texts {
		for _, w := range words(stripCode(text)) {
			for _, lang := range stopwordIndex[w] {
				hits[lang]++
			}
		}
	}
	langs := make([]string, 0, len(hits))
	for lang := range hits {
		langs = append(langs, lang)
	}
	sort.Slice(langs, func(i, j int) bool {
		if hits[langs[i]] != hits[langs[j]] {
			return hits[langs[i]] > hits[langs[j]]
		}
		return langs[i] < langs[j]
	})
	if len(langs) == 0 || hits[langs[0]] < minHits {
		return ""
	}
	if len(langs) > 1 && hits[langs[0]] < leadRatio*hits[langs[1]] {
		return ""
	}
	return langs[0]
}

// ProjectLanguage is .saasfoundry.json's language.tickets, "" when the project declares none.
func ProjectLanguage(projectDir string, readFile func(path string) []byte) string {
	if readFile == nil || projectDir == "" {
		return ""
	}
	data := readFile(filepath.Join(projectDir, ".saasfoundry.json"))
	if data == nil {
		return ""
	}
	var doc struct {
		Language struct {
			Tickets string `json:"tickets"`
		} `json:"language"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return ""
	}
	return Normalize(doc.Language.Tickets)
}

// ReadmeText is the project's README, "" without one.
func ReadmeText(projectDir string, readFile func(path string) []byte) string {
	if readFile == nil || projectDir == "" {
		return ""
	}
	for _, name := range []string{"README.md", "README", "README.markdown", "README.txt", "readme.md", "Readme.md"} {
		if data := readFile(filepath.Join(projectDir, name)); data != nil {
			return string(data)
		}
	}
	return ""
}

// Resolution is the publication language and where it came from.
type Resolution struct {
	Lang   string `json:"lang"`
	Name   string `json:"name"`
	Source string `json:"source"`
}

// Inputs are what Resolve reads; Texts is called only when neither the project nor the setting declares a language.
type Inputs struct {
	ProjectDir string
	ReadFile   func(path string) []byte
	Setting    string
	// Texts: the project's recent pull requests' titles and bodies (read through the developer's gh).
	Texts func() []string
}

// Resolve: the project's language.tickets, else the review:publishlanguage setting, else detected from the pull
// requests and the README, else English.
func Resolve(in Inputs) Resolution {
	res := func(lang string, source string) Resolution {
		return Resolution{Lang: lang, Name: Name(lang), Source: source}
	}
	if lang := ProjectLanguage(in.ProjectDir, in.ReadFile); lang != "" {
		return res(lang, SourceProject)
	}
	if lang := Normalize(in.Setting); lang != "" {
		return res(lang, SourceSetting)
	}
	var texts []string
	if in.Texts != nil {
		texts = in.Texts()
	}
	texts = append(texts, ReadmeText(in.ProjectDir, in.ReadFile))
	if lang := Detect(texts...); lang != "" {
		return res(lang, SourceDetected)
	}
	return res(Default, SourceDefault)
}
