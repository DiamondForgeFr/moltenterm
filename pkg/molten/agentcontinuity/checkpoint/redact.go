// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"regexp"
	"strings"
)

// Secret redaction (DS-CONT-010). Redact runs before every checkpoint write, whoever wrote it, and is meant for every
// briefing too (#180). It errs on the side of redacting: a value lost in the checkpoint is a small cost, a key copied
// into a briefing sent to a cloud agent is not.

const Redacted = "[redacted]"

// Names that hold a sensitive word without being one.
var innocentNames = []string{"keyboard", "keyword", "keystroke", "keypress", "keydown", "keyup", "keyframe", "monkey", "turkey", "hockey", "donkey", "jockey", "whiskey", "tokenizer", "tokenize", "passthrough", "passage"}

var sensitiveWords = []string{"key", "token", "secret", "password", "passwd", "pwd", "credential", "passphrase", "auth"}

// Words whose value is a secret whatever it looks like.
var strongWords = []string{"secret", "password", "passwd", "pwd", "credential", "passphrase"}

// Names that hold a sensitive word and are not secrets: the shell's working folders.
var innocentExactNames = map[string]bool{"pwd": true, "oldpwd": true}

var (
	pemBlockRegex = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`)
	// A key whose end was cut off (a prompt cut to its size limit) is redacted to the end of the text.
	pemOpenRegex = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$`)
	authRegex    = regexp.MustCompile(`(?i)\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:bearer|basic|token|digest|negotiate)\s+)?([^\s"',;]+)`)
	cookieRegex  = regexp.MustCompile(`(?i)\b((?:set-)?cookie["']?\s*:\s*["']?)([^\s;=]+=[^\s;"']*(?:;\s*[^\s;=]+=[^\s;"']*)*)`)
	urlCredRegex = regexp.MustCompile(`\b([a-zA-Z][a-zA-Z0-9+.-]{1,20}://[^/\s:@]+):([^/\s@]+)@`)
	// name, separator, value: NAME=value, export NAME="value", name: value, "name": "value", name = 'value'.
	assignRegex  = regexp.MustCompile(`(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})(["']?)([ \t]*(?::=|:|=)[ \t]*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}\]\[{"'` + "`" + `][^\s,;}\]"'` + "`" + `]*)`)
	tokenRegexes = []*regexp.Regexp{
		regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{10,}`),
		regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{12,}`),
		regexp.MustCompile(`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`),
		regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}`),
		regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]{20,}`),
		regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`),
		regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`),
		regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}`),
		regexp.MustCompile(`\bnpm_[A-Za-z0-9]{36}\b`),
		regexp.MustCompile(`\bhf_[A-Za-z0-9]{30,}\b`),
		regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`),
	}
	shortNumberRegex = regexp.MustCompile(`^\d{1,6}$`)
	variableRefRegex = regexp.MustCompile(`^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$|^\{\{.*\}\}$|^<[^<>]*>$`)
	plainWordRegex   = regexp.MustCompile(`^[a-z]{1,12}$`)
)

// Redact replaces the secrets of a text with [redacted] and counts the replacements.
func Redact(text string) (string, int) {
	if text == "" {
		return text, 0
	}
	count := 0
	text = pemBlockRegex.ReplaceAllStringFunc(text, func(string) string {
		count++
		return Redacted
	})
	text = pemOpenRegex.ReplaceAllStringFunc(text, func(string) string {
		count++
		return Redacted
	})
	text = replaceGroup(authRegex, text, 3, &count)
	text = replaceGroup(cookieRegex, text, 2, &count)
	text = replaceGroup(urlCredRegex, text, 2, &count)
	text = assignRegex.ReplaceAllStringFunc(text, func(match string) string {
		m := assignRegex.FindStringSubmatch(match)
		if m == nil || !sensitiveName(m[2]) {
			return match
		}
		quoted := m[1] != "" && m[1] == m[3]
		value := m[5]
		if !secretValue(value, strings.TrimSpace(m[4]), quoted || strongName(m[2])) {
			return match
		}
		count++
		return m[1] + m[2] + m[3] + m[4] + quoteLike(value, Redacted)
	})
	for _, re := range tokenRegexes {
		text = re.ReplaceAllStringFunc(text, func(string) string {
			count++
			return Redacted
		})
	}
	return text, count
}

// replaceGroup redacts one group of each match, the rest of the match kept.
func replaceGroup(re *regexp.Regexp, text string, group int, count *int) string {
	return re.ReplaceAllStringFunc(text, func(match string) string {
		idx := re.FindStringSubmatchIndex(match)
		if idx == nil || idx[2*group] < 0 {
			return match
		}
		value := match[idx[2*group]:idx[2*group+1]]
		if value == Redacted || strings.HasPrefix(value, "[redacted") {
			return match
		}
		*count++
		return match[:idx[2*group]] + Redacted + match[idx[2*group+1]:]
	})
}

func sensitiveName(name string) bool {
	lower := strings.ToLower(name)
	if innocentExactNames[lower] {
		return false
	}
	for _, innocent := range innocentNames {
		lower = strings.ReplaceAll(lower, innocent, "")
	}
	for _, word := range sensitiveWords {
		if !strings.Contains(lower, word) {
			continue
		}
		// "auth" alone is too common a prefix (author, authored): only as a word of the name.
		if word == "auth" && !nameHasWord(lower, "auth") {
			continue
		}
		return true
	}
	return false
}

func strongName(name string) bool {
	lower := strings.ToLower(name)
	for _, word := range strongWords {
		if strings.Contains(lower, word) {
			return true
		}
	}
	return false
}

func nameHasWord(lower string, word string) bool {
	for _, part := range strings.FieldsFunc(lower, func(r rune) bool { return r == '_' || r == '-' || r == '.' }) {
		if part == word {
			return true
		}
	}
	return false
}

// secretValue tells a value worth redacting: not empty, not a reference to a variable or a placeholder, not already
// redacted. With a colon (YAML, or prose such as "the key: rotate it"), an unquoted single plain word is kept, unless
// the name is quoted (JSON) or names a password or a secret (strict).
func secretValue(value string, sep string, strict bool) bool {
	inner := strings.Trim(value, `"'`)
	switch strings.ToLower(inner) {
	case "", "true", "false", "null", "none", "nil", "undefined", "[redacted]", "redacted", "***", "...", "…":
		return false
	}
	if strings.HasPrefix(inner, "[redacted") || strings.HasPrefix(inner, "<") || variableRefRegex.MatchString(inner) || shortNumberRegex.MatchString(inner) {
		return false
	}
	unquotedValue := inner == value
	if sep == ":" && !strict && unquotedValue && plainWordRegex.MatchString(inner) {
		return false
	}
	return true
}

func quoteLike(value string, replacement string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return string(value[0]) + replacement + string(value[0])
	}
	return replacement
}

// CountRedacted counts the redactions a text holds.
func CountRedacted(text string) int {
	return strings.Count(text, Redacted)
}
