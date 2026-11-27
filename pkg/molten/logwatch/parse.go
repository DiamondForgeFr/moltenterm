// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The kinds of a signature (FR-BOSS-012 AC4).
const (
	// KindPanic: a panic wavesrv recovered ("[panic] in ...", pkg/panichandler).
	KindPanic = "panic"
	// KindCrash: what ends a process: an unrecovered Go panic, a fatal error, Electron main's uncaught exception, wavesrv
	// exiting on a failure.
	KindCrash   = "crash"
	KindError   = "error"
	KindWarning = "warning"
)

const (
	// maxFrames: the top frames a panic's or a crash's signature keeps.
	maxFrames = 3
	// maxStackLines: the lines of a stack read after its head; a dump longer than this is cut.
	maxStackLines = 120
	// maxEntryLines, maxLineBytes: what an entry keeps of its text, its head and a stack's worth of lines, each cut; the
	// bytes of the rest still count for the log's growth. A huge entry costs a bounded copy, never a quadratic one.
	maxEntryLines = maxStackLines + 1
	maxLineBytes  = 4096
	// maxPatternRunes: the normalised message a signature keeps.
	maxPatternRunes = 240
	// maxExcerptLines, maxExcerptBytes: what a signature keeps of its last occurrence, for the card and the brief.
	maxExcerptLines = 40
	maxExcerptBytes = 8 * 1024
	// timestampLayout is the stamp Electron main's logger writes before every entry (emain/emain-log.ts).
	timestampLayout = "2006-01-02 15:04:05.000"
	// ownMark is in the log watch's own lines, which it never reads as a problem.
	ownMark      = "molten: logwatch:"
	modulePrefix = "github.com/wavetermdev/waveterm/"
)

var (
	timestampRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) ?`)

	// The heads are anchored at the start of the line: a log line that quotes "[panic] in " in its middle (a message, a
	// page's title) is no panic.
	crashHeadRe = regexp.MustCompile(`^(?:\[wavesrv\] )?(?:panic: |fatal error: )|^Uncaught Exception|` +
		`^wavesrv exited \(code [1-9]\d*|^wavesrv exited \(code [^,]*, signal SIG(?:SEGV|ABRT|BUS|ILL|FPE|TRAP|SYS)\)`)
	panicHeadRe = regexp.MustCompile(`^(?:\[wavesrv\] )?\[panic\] in `)
	// errWordRe, errorWordRe and warningWordRe read a lower-cased line, once a plain substring check found the word in
	// it. The word stands alone: inside an identifier ("ciFailed", "onErrorRetry", "noFailure", #2577) it is data.
	errWordRe   = regexp.MustCompile(`(?:^|[^a-z])err(?:[^a-z]|$)`)
	errorWordRe = regexp.MustCompile(`(?:^|[^a-z])(?:errors?|errored|exceptions?|failed|failures?|fatal)(?:[^a-z]|$)`)
	// errorTypeRe reads the line as written: an error type's name ("TypeError", "NullPointerException") ends with the
	// word glued to a capitalised name, which a lower-cased word match cannot tell from an identifier.
	errorTypeRe   = regexp.MustCompile(`(?:^|[^A-Za-z0-9_])[A-Z][A-Za-z0-9]*(?:Error|Exception)(?:[^A-Za-z0-9_]|$)`)
	warningWordRe = regexp.MustCompile(`(?:^|[^a-z])(?:warn|warning)(?:[^a-z]|$)`)
	// emptyMentionRe is an error or warning field that holds nothing ("err:<nil>", "error=null", `"warning": none`): a
	// report that all went well, which says nothing of a problem. It reads a lower-cased line; the end of a bare word
	// is a word boundary, so "err=nilable" or "error: nullified" stay mentions. "undefined" is left out on purpose:
	// JavaScript prints "Error: undefined" for an error thrown without a message, which is a real one.
	emptyMentionRe = regexp.MustCompile(`(^|[^a-z])(?:err|errs|error|errors|warn|warning|warnings)"?\s*[:=]\s*` +
		`(?:<nil>|<none>|<null>|(?:nil|null|none)\b)`)

	goroutineRe = regexp.MustCompile(`^goroutine \d+ \[`)
	goFuncRe    = regexp.MustCompile(`^[\w.\-/]+(?:\.\(\*?[\w\-\[\],. ]+\))?\.[\w$.\-\[\]]+\(.*\)$|^panic\(.*\)$|^main\.main\(\)$`)
	jsAtRe      = regexp.MustCompile(`^\s+at (.+)$`)
	jsNamedRe   = regexp.MustCompile(`^(.+?) \(.*\)$`)

	uuidRe    = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	urlRe     = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s'"<>()\]]+`)
	pathRe    = regexp.MustCompile(`(^|[\s'"(=\[:,])(?:~|\.{1,2})?/[^\s'"(),\]]*|(^|[\s'"(=\[:,])[A-Za-z]:\\[^\s'"(),\]]*`)
	hexRe     = regexp.MustCompile(`0x[0-9a-fA-F]+`)
	longIdRe  = regexp.MustCompile(`\b[0-9a-fA-F]{12,}\b`)
	shortIdRe = regexp.MustCompile(`\b[0-9a-fA-F]{7,11}\b`)
	numberRe  = regexp.MustCompile(`\d+(?:\.\d+)?`)

	// What masking takes out of what is kept and sent (FR-BOSS-012 AC10): secrets MoltenTerm recognises, the query and
	// user-info of addresses, emails. It over-masks rather than lets one through. Each rule runs only when one of its
	// hints is in the lower-cased text, so a line with none of them costs a few substring checks.
	secretRules = []secretRule{
		{[]string{"bearer", "basic"}, regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}`), "$1 <secret>"},
		{[]string{"token", "passw", "pwd", "secret", "key", "credential", "cookie", "session", "auth"},
			regexp.MustCompile(`(?i)\b([a-z0-9_.-]*(?:token|passwd|password|pwd|secret|api[_-]?key|apikey|credential|cookie|session|auth)[a-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)`),
			"$1$2<secret>"},
		{[]string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"}, regexp.MustCompile(`\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}`), "<secret>"},
		{[]string{"sk-"}, regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{10,}`), "<secret>"},
		{[]string{"akia", "asia"}, regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`), "<secret>"},
		{[]string{"xox"}, regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`), "<secret>"},
		{[]string{"glpat-"}, regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]{10,}`), "<secret>"},
		{[]string{"eyj"}, regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}`), "<jwt>"},
	}
	emailRe = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
)

type secretRule struct {
	hints []string
	re    *regexp.Regexp
	with  string
}

func containsAny(text string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(text, sub) {
			return true
		}
	}
	return false
}

// entry is one entry of the log: its stamp (zero when the line had none) and its text, continuation lines included.
type entry struct {
	at    time.Time
	text  string
	bytes int64
}

// Record is one problem the log shows: a head line, classified, with the stack that follows it.
type Record struct {
	Kind    string
	At      time.Time
	Head    string
	Stack   []string
	Pattern string
	Frames  []string
}

// Id is the record's signature: its kind, its normalised message and its top frames.
func (r Record) Id() string {
	sum := sha256.Sum256([]byte(r.Kind + "\n" + r.Pattern + "\n" + strings.Join(r.Frames, "\n")))
	return hex.EncodeToString(sum[:8])
}

// splitStamp cuts the logger's stamp off a line; ok is false for a line without one (a continuation line).
func splitStamp(line string, loc *time.Location) (time.Time, string, bool) {
	m := timestampRe.FindStringSubmatchIndex(line)
	if m == nil {
		return time.Time{}, line, false
	}
	at, err := time.ParseInLocation(timestampLayout, line[m[2]:m[3]], loc)
	if err != nil {
		return time.Time{}, line, false
	}
	return at, line[m[1]:], true
}

// entriesOf reads the complete lines of chunk into entries. A line without a stamp continues the entry before it (a
// message the logger wrote over several lines); a chunk that starts with one makes an entry of its own. An entry keeps
// at most maxEntryLines lines of at most maxLineBytes each; its bytes count every line.
func entriesOf(chunk []byte, loc *time.Location) []entry {
	var out []entry
	var text strings.Builder
	kept := 0
	flush := func() {
		if len(out) > 0 {
			out[len(out)-1].text = text.String()
		}
		text.Reset()
		kept = 0
	}
	for len(chunk) > 0 {
		end := bytes.IndexByte(chunk, '\n')
		var line []byte
		if end < 0 {
			line, chunk = chunk, nil
		} else {
			line, chunk = chunk[:end], chunk[end+1:]
		}
		size := int64(len(line) + 1)
		if len(line) > maxLineBytes {
			line = line[:maxLineBytes]
		}
		raw := strings.TrimRight(string(line), "\r")
		if !utf8.ValidString(raw) {
			raw = strings.ToValidUTF8(raw, "?")
		}
		at, body, stamped := splitStamp(raw, loc)
		if !stamped && len(out) > 0 {
			out[len(out)-1].bytes += size
			if kept < maxEntryLines {
				text.WriteByte('\n')
				text.WriteString(body)
				kept++
			}
			continue
		}
		flush()
		out = append(out, entry{at: at, bytes: size})
		text.WriteString(body)
		kept = 1
	}
	flush()
	return out
}

// classify says what kind of problem a line's text is, "" for none.
func classify(text string) string {
	first, _, _ := strings.Cut(text, "\n")
	if strings.Contains(first, ownMark) {
		return ""
	}
	switch {
	case crashHeadRe.MatchString(first):
		return KindCrash
	case panicHeadRe.MatchString(first):
		return KindPanic
	case isStackLine(first):
		return ""
	}
	lower := strings.ToLower(first)
	if containsAny(lower, "nil", "null", "none") {
		lower = emptyMentionRe.ReplaceAllString(lower, "${1} ")
	}
	switch {
	case containsAny(lower, "error", "exception", "failed", "failure", "fatal") &&
		(errorWordRe.MatchString(lower) || errorTypeRe.MatchString(first)):
		return KindError
	case strings.Contains(lower, "err") && errWordRe.MatchString(lower):
		return KindError
	case strings.Contains(lower, "warn") && warningWordRe.MatchString(lower):
		return KindWarning
	}
	return ""
}

// isStackLine: a line of a Go or JavaScript stack, or of a Go crash dump around it.
func isStackLine(text string) bool {
	trimmed := strings.TrimSpace(text)
	switch {
	case trimmed == "":
		return true
	case strings.HasPrefix(text, "\t"):
		return true
	case goroutineRe.MatchString(trimmed):
		return true
	case strings.HasPrefix(trimmed, "created by "):
		return true
	case strings.HasPrefix(trimmed, "[recovered]") || strings.HasPrefix(trimmed, "[signal "):
		return true
	case jsAtRe.MatchString(text):
		return true
	case strings.HasPrefix(trimmed, "Stack Trace:"):
		return true
	}
	return goFuncRe.MatchString(trimmed)
}

// frameOf is the function a stack line names, "" for a line that names none or a frame that says nothing of where the
// problem is (the runtime's, the panic handler's, Node's own).
func frameOf(line string) string {
	trimmed := strings.TrimSpace(line)
	if strings.HasPrefix(line, "\t") || trimmed == "" || goroutineRe.MatchString(trimmed) || strings.HasPrefix(trimmed, "created by ") {
		return ""
	}
	var name string
	if m := jsAtRe.FindStringSubmatch(line); m != nil {
		at := strings.TrimSpace(m[1])
		if n := jsNamedRe.FindStringSubmatch(at); n != nil {
			name = n[1]
		} else {
			name = "<anonymous>"
		}
		if strings.HasPrefix(at, "node:") || strings.Contains(at, "(node:") {
			return ""
		}
		return strings.TrimPrefix(name, "async ")
	}
	if !goFuncRe.MatchString(trimmed) {
		return ""
	}
	if i := strings.LastIndex(trimmed, "("); i > 0 {
		name = trimmed[:i]
	}
	if name == "" || name == "panic" || strings.HasPrefix(name, "runtime.") || strings.HasPrefix(name, "runtime/") ||
		strings.Contains(name, "panichandler.") {
		return ""
	}
	return strings.TrimPrefix(name, modulePrefix)
}

// normalise is a message with what changes from one occurrence to the next written the same: uuids and long ids,
// addresses, paths, hexadecimal values and numbers.
func normalise(text string) string {
	if strings.Contains(text, "-") {
		text = uuidRe.ReplaceAllString(text, "<id>")
	}
	if strings.Contains(text, "://") {
		text = urlRe.ReplaceAllString(text, "<url>")
	}
	if strings.ContainsAny(text, `/\`) {
		text = pathRe.ReplaceAllString(text, "${1}${2}<path>")
	}
	if strings.Contains(text, "0x") {
		text = hexRe.ReplaceAllString(text, "<hex>")
	}
	text = longIdRe.ReplaceAllString(text, "<id>")
	text = shortIdRe.ReplaceAllStringFunc(text, func(word string) string {
		if isMixedHex(word) {
			return "<id>"
		}
		return word
	})
	text = numberRe.ReplaceAllString(text, "<n>")
	text = strings.Join(strings.Fields(text), " ")
	return cutRunes(text, maxPatternRunes)
}

// isMixedHex: a short hexadecimal id (a short commit, a request id) has digits and letters; a word of letters alone
// ("decade", "facade") or a number is not one.
func isMixedHex(word string) bool {
	return strings.ContainsAny(word, "0123456789") && strings.ContainsAny(strings.ToLower(word), "abcdef")
}

func cutRunes(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max-1]) + "…"
}

// recordsOf groups the entries into records: each problem with the stack lines that follow it. The entries' bytes go
// to the minute of their stamp, for the log's growth, whether they are a problem or not.
func recordsOf(entries []entry, fallback time.Time, bytes func(at time.Time, n int64)) []Record {
	var out []Record
	last := fallback
	// A loop writes the same head again and again: its pattern is worked out once.
	patterns := map[string]string{}
	for i := 0; i < len(entries); i++ {
		e := entries[i]
		if !e.at.IsZero() {
			last = e.at
		}
		bytes(last, e.bytes)
		kind := classify(e.text)
		if kind == "" {
			continue
		}
		head, rest, _ := strings.Cut(e.text, "\n")
		rec := Record{Kind: kind, At: last, Head: strings.TrimSpace(head)}
		if rest != "" {
			rec.Stack = append(rec.Stack, strings.Split(rest, "\n")...)
		}
		if kind == KindPanic || kind == KindCrash {
			for i+1 < len(entries) && len(rec.Stack) < maxStackLines {
				next := entries[i+1]
				lines := strings.Split(next.text, "\n")
				if !isStackLine(lines[0]) {
					break
				}
				i++
				if !next.at.IsZero() {
					last = next.at
				}
				bytes(last, next.bytes)
				rec.Stack = append(rec.Stack, lines...)
			}
			if len(rec.Stack) > maxStackLines {
				rec.Stack = rec.Stack[:maxStackLines]
			}
			for _, line := range rec.Stack {
				if frame := frameOf(line); frame != "" {
					rec.Frames = append(rec.Frames, frame)
					if len(rec.Frames) == maxFrames {
						break
					}
				}
			}
		}
		pattern, ok := patterns[rec.Head]
		if !ok {
			pattern = normalise(redact(rec.Head))
			patterns[rec.Head] = pattern
		}
		rec.Pattern = pattern
		out = append(out, rec)
	}
	return out
}

// redact masks the query string, fragment and user-info of addresses first (a token in a fragment would otherwise cut
// the address), then the secrets MoltenTerm recognises, then emails.
func redact(text string) string {
	if strings.Contains(text, "://") {
		text = urlRe.ReplaceAllStringFunc(text, redactAddress)
	}
	lower := strings.ToLower(text)
	for _, rule := range secretRules {
		if containsAny(lower, rule.hints...) {
			text = rule.re.ReplaceAllString(text, rule.with)
		}
	}
	if strings.Contains(text, "@") {
		text = emailRe.ReplaceAllString(text, "<email>")
	}
	return text
}

// redactAddress keeps an address's scheme, host and path: user-info, query and fragment may hold credentials.
func redactAddress(address string) string {
	scheme, rest, ok := strings.Cut(address, "://")
	if !ok {
		return address
	}
	authority, path := rest, ""
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		authority, path = rest[:i], rest[i:]
	}
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		authority = authority[at+1:]
	}
	if i := strings.IndexByte(path, '#'); i >= 0 {
		path = path[:i] + "#<fragment>"
	}
	if i := strings.IndexByte(path, '?'); i >= 0 {
		tail := ""
		if j := strings.IndexByte(path[i:], '#'); j >= 0 {
			tail = path[i+j:]
		}
		path = path[:i] + "?<query>" + tail
	}
	return scheme + "://" + authority + path
}

// masker masks what is kept of a log or sent from it: the home folder, written ~ whatever its case and its slashes, and
// everything redact masks.
type masker struct {
	home *regexp.Regexp
}

func makeMasker(home string) masker {
	home = strings.TrimRight(home, `/\`)
	if len(home) < 2 {
		return masker{}
	}
	var sb strings.Builder
	sb.WriteString("(?i)")
	for _, r := range home {
		if r == '/' || r == '\\' {
			sb.WriteString(`[\\/]`)
			continue
		}
		sb.WriteString(regexp.QuoteMeta(string(r)))
	}
	re, err := regexp.Compile(sb.String())
	if err != nil {
		return masker{}
	}
	return masker{home: re}
}

func (m masker) mask(text string) string {
	if m.home != nil {
		text = m.home.ReplaceAllLiteralString(text, "~")
	}
	return redact(text)
}

// excerptOf is what a signature keeps of an occurrence: its head and the start of its stack, masked, control
// characters dropped, bounded.
func excerptOf(r Record, m masker) string {
	lines := append([]string{r.Head}, r.Stack...)
	if len(lines) > maxExcerptLines {
		lines = lines[:maxExcerptLines]
	}
	text := strings.TrimRight(strings.Join(lines, "\n"), "\n ")
	text = m.mask(text)
	text = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, text)
	if len(text) > maxExcerptBytes {
		text = strings.ToValidUTF8(text[:maxExcerptBytes], "") + "\n…"
	}
	return text
}

// withHome writes the developer's home folder ~ in a path the brief names (the log's own).
func withHome(text string, home string) string {
	return makeMasker(home).mask(text)
}
