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

	crashHeadRe   = regexp.MustCompile(`^(?:\[wavesrv\] )?(?:panic: |fatal error: )|Uncaught Exception|wavesrv exited \(code [1-9]\d*|wavesrv exited \(code [^,]*, signal SIG(?:SEGV|ABRT|BUS|ILL|FPE|TRAP|SYS)\)`)
	panicHeadRe   = regexp.MustCompile(`\[panic\] in `)
	errorWordRe   = regexp.MustCompile(`(?i)error|exception|failed|failure|fatal|(?:^|[^a-z])err(?:[^a-z]|$)`)
	warningWordRe = regexp.MustCompile(`(?i)(?:^|[^a-z])(?:warn|warning)(?:[^a-z]|$)`)

	goroutineRe = regexp.MustCompile(`^goroutine \d+ \[`)
	goFuncRe    = regexp.MustCompile(`^[\w.\-/]+(?:\.\(\*?[\w\-\[\],. ]+\))?\.[\w$.\-\[\]]+\(.*\)$|^panic\(.*\)$|^main\.main\(\)$`)
	jsAtRe      = regexp.MustCompile(`^\s+at (.+)$`)
	jsNamedRe   = regexp.MustCompile(`^(.+?) \(.*\)$`)

	uuidRe   = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	urlRe    = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s'"<>()\]]+`)
	pathRe   = regexp.MustCompile(`(^|[\s'"(=\[:,])(?:~|\.{1,2})?/[^\s'"(),\]]*|(^|[\s'"(=\[:,])[A-Za-z]:\\[^\s'"(),\]]*`)
	hexRe    = regexp.MustCompile(`0x[0-9a-fA-F]+`)
	longIdRe = regexp.MustCompile(`\b[0-9a-fA-F]{12,}\b`)
	numberRe = regexp.MustCompile(`\d+(?:\.\d+)?`)
)

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
// message the logger wrote over several lines); a chunk that starts with one makes an entry of its own.
func entriesOf(chunk []byte, loc *time.Location) []entry {
	var out []entry
	for len(chunk) > 0 {
		end := bytes.IndexByte(chunk, '\n')
		var line []byte
		if end < 0 {
			line, chunk = chunk, nil
		} else {
			line, chunk = chunk[:end], chunk[end+1:]
		}
		raw := strings.TrimRight(string(line), "\r")
		if !utf8.ValidString(raw) {
			raw = strings.ToValidUTF8(raw, "?")
		}
		at, text, stamped := splitStamp(raw, loc)
		size := int64(len(line) + 1)
		if !stamped && len(out) > 0 {
			last := &out[len(out)-1]
			last.text += "\n" + text
			last.bytes += size
			continue
		}
		out = append(out, entry{at: at, text: text, bytes: size})
	}
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
	case errorWordRe.MatchString(first):
		return KindError
	case warningWordRe.MatchString(first):
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
	text = uuidRe.ReplaceAllString(text, "<id>")
	text = urlRe.ReplaceAllString(text, "<url>")
	text = pathRe.ReplaceAllString(text, "${1}${2}<path>")
	text = hexRe.ReplaceAllString(text, "<hex>")
	text = longIdRe.ReplaceAllString(text, "<id>")
	text = numberRe.ReplaceAllString(text, "<n>")
	text = strings.Join(strings.Fields(text), " ")
	return cutRunes(text, maxPatternRunes)
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
		rec.Pattern = normalise(rec.Head)
		out = append(out, rec)
	}
	return out
}

// excerptOf is what a signature keeps of an occurrence: its head and the start of its stack, the home folder written ~,
// control characters dropped, bounded.
func excerptOf(r Record, home string) string {
	lines := append([]string{r.Head}, r.Stack...)
	if len(lines) > maxExcerptLines {
		lines = lines[:maxExcerptLines]
	}
	text := strings.TrimRight(strings.Join(lines, "\n"), "\n ")
	text = withHome(text, home)
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

// withHome writes the developer's home folder ~ in text: an excerpt names fewer of their own folders that way.
func withHome(text string, home string) string {
	home = strings.TrimRight(home, `/\`)
	if len(home) < 2 {
		return text
	}
	return strings.ReplaceAll(text, home, "~")
}
