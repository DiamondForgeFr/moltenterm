// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"strings"
	"testing"
	"time"
)

func recordsOfText(text string) []Record {
	return recordsOf(entriesOf([]byte(text), time.UTC), day, func(time.Time, int64) {})
}

// FR-BOSS-012 AC4: what changes from one occurrence to the next (ids, numbers, paths, hexadecimal values, uuids) is
// written alike, so the same problem is one signature.
func TestNormaliseWritesWhatChangesAlike(t *testing.T) {
	t.Parallel()
	same := [][2]string{
		{"[wavesrv] error reading /home/a/x/state.json: block 2b1e0b9c-5a2f-4e44-9d1c-0b6f2a8c9e11 gone after 12ms",
			"[wavesrv] error reading /tmp/other/state.json: block 7f00aa11-0000-4bbb-8ccc-123456789abc gone after 3401ms"},
		{"index out of range [3] with length 3", "index out of range [17] with length 12"},
		{"bad pointer 0xc000123456", "bad pointer 0xc0009f0000"},
		{"commit 4e3b72a9f00d1c2b not found", "commit 0011aabbccddeeff not found"},
		{"fetch https://example.test/a?b=1 failed", "fetch https://example.test/zz failed"},
		{`open C:\Users\someone\log.txt failed`, `open D:\data\x.txt failed`},
		{"  many   spaces  error ", "many spaces error"},
	}
	for _, pair := range same {
		if a, b := normalise(pair[0]), normalise(pair[1]); a != b {
			t.Errorf("not alike:\n%q -> %q\n%q -> %q", pair[0], a, pair[1], b)
		}
	}
	different := [][2]string{
		{"error reading the state", "error writing the state"},
		{"[panic] in molten:a: nil map", "[panic] in molten:b: nil map"},
	}
	for _, pair := range different {
		if normalise(pair[0]) == normalise(pair[1]) {
			t.Errorf("%q and %q are one signature", pair[0], pair[1])
		}
	}
	if got := normalise("read/write I/O error at 12"); !strings.Contains(got, "read/write I/O error") {
		t.Errorf("a slash inside words is no path: %q", got)
	}
	long := normalise(strings.Repeat("word ", 200))
	if n := len([]rune(long)); n > maxPatternRunes {
		t.Errorf("pattern of %d runes", n)
	}
}

func TestClassify(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"[wavesrv] [panic] in molten:x: runtime error: invalid memory address":      KindPanic,
		"panic: runtime error: index out of range [5] with length 5":                KindCrash,
		"[wavesrv] fatal error: concurrent map writes":                              KindCrash,
		"Uncaught Exception, shutting down:  TypeError: x is undefined":             KindCrash,
		"wavesrv exited (code 2, signal null), shutting down":                       KindCrash,
		"wavesrv exited (code null, signal SIGSEGV), shutting down":                 KindCrash,
		"[wavesrv] error reading config: no such file":                              KindError,
		"TypeError: Cannot read properties of undefined":                            KindError,
		"[wavesrv] sync failed: timeout":                                            KindError,
		"[wavesrv] err: closed":                                                     KindError,
		"[wavesrv] WARNING: slow query":                                             KindWarning,
		"[wavesrv] warn: deprecated option":                                         KindWarning,
		"wavesrv exited (code 0, signal null), shutting down":                       "",
		"wavesrv exited (code null, signal SIGTERM), shutting down":                 "",
		"[wavesrv] stderr closed":                                                   "",
		"[wavesrv] workspace switched":                                              "",
		"goroutine 12 [running]:":                                                   "",
		"\t/src/x.go:12 +0x1d":                                                      "",
		"[wavesrv] molten: logwatch: reading the log: error: permission denied":     "",
		"github.com/wavetermdev/waveterm/pkg/molten/fake.(*worker).failed(0xc0001)": "",
	}
	for text, want := range cases {
		if got := classify(text); got != want {
			t.Errorf("classify(%q) = %q, want %q", text, got, want)
		}
	}
}

// #2372: an error or warning field that holds nothing is the report of a success, not a problem; a real error word
// elsewhere on the line keeps the line's kind.
func TestAnEmptyErrorMentionIsNoProblem(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"[wavesrv] filestore flush: 2/2 entries flushed, err:<nil>":       "",
		"[wavesrv] sync done, err=<nil>":                                  "",
		"[wavesrv] sync done, err: <nil>":                                 "",
		"[wavesrv] sync done, err=nil":                                    "",
		"[wavesrv] sync done, ERR = NIL":                                  "",
		"[wavesrv] sync done, error: <nil>":                               "",
		"[wavesrv] sync done, error=null":                                 "",
		`[wavesrv] sync done {"error":null,"warning":null}`:               "",
		"[wavesrv] sync done, errors: none":                               "",
		"[wavesrv] check done, warning: <nil>":                            "",
		"[wavesrv] check done, warn=nil":                                  "",
		"[wavesrv] sync done, err=nil, err=<nil>":                         "",
		"[wavesrv] err: connection refused":                               KindError,
		"[wavesrv] error: <nil> then failed: boom":                        KindError,
		"[wavesrv] err=<nil> on first try, err=timeout on the second one": KindError,
		"[wavesrv] err=nilable value":                                     KindError,
		"[wavesrv] error: nullified handle":                               KindError,
		"Error: undefined":                                                KindError,
		"[wavesrv] err:<nil> but warning: disk almost full":               KindWarning,
		"[wavesrv] warning: <nil>, error: disk full":                      KindError,
	}
	for text, want := range cases {
		if got := classify(text); got != want {
			t.Errorf("classify(%q) = %q, want %q", text, got, want)
		}
	}
}

// A recovered panic is one record with its stack; its top frames skip the runtime's, the panic handler's and panic()
// itself, and the ordinary line after it is not part of it.
func TestAPanicIsGroupedWithItsStack(t *testing.T) {
	t.Parallel()
	text := panicLines(day, "runtime error: index out of range [3] with length 3", "step") +
		stamped(day.Add(time.Second), "[wavesrv] workspace switched")
	recs := recordsOfText(text)
	if len(recs) != 1 {
		t.Fatalf("records: %+v", recs)
	}
	r := recs[0]
	if r.Kind != KindPanic || !r.At.Equal(day) {
		t.Fatalf("record: %+v", r)
	}
	want := []string{"pkg/molten/fake.(*worker).step", "pkg/molten/fake.(*worker).loop"}
	if strings.Join(r.Frames, "|") != strings.Join(want, "|") {
		t.Fatalf("frames %q, want %q", r.Frames, want)
	}
	if len(r.Stack) != 15 {
		t.Fatalf("stack of %d lines: %q", len(r.Stack), r.Stack)
	}
}

// The same panic at another time, from another goroutine at other addresses, is the same signature; the same message
// from another function is another one.
func TestTheSignatureIsTheMessageAndTheTopFrames(t *testing.T) {
	t.Parallel()
	a := recordsOfText(panicLines(day, "runtime error: index out of range [3] with length 3", "step"))[0]
	b := recordsOfText(strings.ReplaceAll(panicLines(day.Add(time.Hour), "runtime error: index out of range [9] with length 2", "step"),
		"0xc000123456", "0xc000ffee00"))[0]
	c := recordsOfText(panicLines(day, "runtime error: index out of range [3] with length 3", "flush"))[0]
	if a.Id() != b.Id() {
		t.Errorf("one problem, two signatures: %q %q / %q %q", a.Pattern, a.Frames, b.Pattern, b.Frames)
	}
	if a.Id() == c.Id() {
		t.Error("another function is the same signature")
	}
}

// Electron main's uncaught exception is a crash; its JavaScript frames name the functions, Node's own are skipped.
func TestAnUncaughtExceptionIsACrashWithItsFrames(t *testing.T) {
	t.Parallel()
	text := stamped(day, "Uncaught Exception, shutting down:  TypeError: Cannot read properties of undefined (reading 'id')\n"+
		"    at Object.openTab (/opt/app/dist/main/index.js:120:33)\n"+
		"    at emitOne (node:events:96:13)\n"+
		"    at async Server.handle (/opt/app/dist/main/index.js:88:5)") +
		stamped(day, "Stack Trace: TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.openTab (/opt/app/dist/main/index.js:120:33)") +
		stamped(day.Add(time.Second), "spawned wavesrv")
	recs := recordsOfText(text)
	if len(recs) != 1 || recs[0].Kind != KindCrash {
		t.Fatalf("records: %+v", recs)
	}
	want := "Object.openTab|Server.handle|Object.openTab"
	if got := strings.Join(recs[0].Frames, "|"); got != want {
		t.Fatalf("frames %q, want %q", got, want)
	}
}

// A line without a stamp continues the entry before it; a chunk that starts with one keeps it; bytes go to the minute
// of the stamp before them.
func TestEntriesAndTheirBytes(t *testing.T) {
	t.Parallel()
	text := "orphan line\n" + stamped(day, "first\nmore of first") + stamped(day.Add(2*time.Minute), "second")
	entries := entriesOf([]byte(text), time.UTC)
	if len(entries) != 3 || entries[0].text != "orphan line" || entries[1].text != "first\nmore of first" || entries[2].text != "second" {
		t.Fatalf("entries: %+v", entries)
	}
	byMinute := map[int64]int64{}
	recordsOf(entries, day.Add(-time.Hour), func(at time.Time, n int64) { byMinute[minuteOf(at.UnixMilli())] += n })
	var total int64
	for _, n := range byMinute {
		total += n
	}
	if total != int64(len(text)) {
		t.Fatalf("counted %d bytes of %d", total, len(text))
	}
	if byMinute[minuteOf(day.Add(2*time.Minute).UnixMilli())] != int64(len(stamped(day, "second"))) {
		t.Fatalf("by minute: %v", byMinute)
	}
}

// The excerpt is the occurrence as the log has it, the home folder written ~, control characters out, bounded.
func TestTheExcerptHidesTheHomeFolderAndIsBounded(t *testing.T) {
	t.Parallel()
	r := recordsOfText(panicLines(day, "boom \x1b[31mred\x1b[0m", "step"))[0]
	excerpt := excerptOf(r, makeMasker(fakeHome))
	if strings.Contains(excerpt, fakeHome) || !strings.Contains(excerpt, "~/src/pkg/molten/fake/worker.go:42") {
		t.Fatalf("home folder in the excerpt:\n%s", excerpt)
	}
	if strings.ContainsRune(excerpt, '\x1b') {
		t.Fatal("a control character stayed in the excerpt")
	}
	r.Stack = make([]string, 200)
	for i := range r.Stack {
		r.Stack[i] = strings.Repeat("x", 500)
	}
	if long := excerptOf(r, makeMasker(fakeHome)); len(long) > maxExcerptBytes+8 || strings.Count(long, "\n") > maxExcerptLines {
		t.Fatalf("excerpt of %d bytes, %d lines", len(long), strings.Count(long, "\n"))
	}
}
