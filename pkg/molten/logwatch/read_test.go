// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func logFiles(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	logs := filepath.Join(dir, LogsDirName)
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, LogFileName), logs
}

func readAll(t *testing.T, path string, logs string, mark fileMark) (string, readOut, fileMark) {
	t.Helper()
	out, next, err := readNew(path, logs, mark)
	if err != nil {
		t.Fatal(err)
	}
	return string(bytes.Join(out.chunks, nil)), out, next
}

func numbered(prefix string, from int, to int) string {
	var sb strings.Builder
	for i := from; i < to; i++ {
		sb.WriteString(stamped(day.Add(time.Duration(i)*time.Second), fmt.Sprintf("%s line %d", prefix, i)))
	}
	return sb.String()
}

// FR-BOSS-012 AC2: each look reads what was written since the last one, and an unfinished last line waits for the next.
func TestEachLookReadsOnlyWhatIsNew(t *testing.T) {
	t.Parallel()
	path, logs := logFiles(t)
	appendLog(t, path, numbered("a", 0, 3))
	got, _, mark := readAll(t, path, logs, fileMark{})
	if got != numbered("a", 0, 3) {
		t.Fatalf("first look read %q", got)
	}
	appendLog(t, path, numbered("a", 3, 5)+"2026-03-09 10:00:09.000 unfinis")
	got, _, mark = readAll(t, path, logs, mark)
	if got != numbered("a", 3, 5) {
		t.Fatalf("second look read %q", got)
	}
	appendLog(t, path, "hed\n")
	got, _, mark = readAll(t, path, logs, mark)
	if got != "2026-03-09 10:00:09.000 unfinished\n" {
		t.Fatalf("third look read %q", got)
	}
	if got, _, _ = readAll(t, path, logs, mark); got != "" {
		t.Fatalf("a look with nothing new read %q", got)
	}
	if info, _ := os.Stat(path); mark.Offset != info.Size() {
		t.Fatalf("offset %d of %d", mark.Offset, info.Size())
	}
}

// The very first look reads the end of a large log only, from a whole line; the history before it is left alone.
func TestTheFirstLookReadsTheEndOnly(t *testing.T) {
	t.Parallel()
	path, logs := logFiles(t)
	filler := strings.Repeat(stamped(day, "[wavesrv] ordinary history line"), (InitialTail/48)+2000)
	appendLog(t, path, filler+stamped(day.Add(time.Hour), "[wavesrv] the newest line"))
	got, out, mark := readAll(t, path, logs, fileMark{})
	if int64(len(got)) > InitialTail || !strings.HasSuffix(got, "[wavesrv] the newest line\n") {
		t.Fatalf("first look read %d bytes, ending %q", len(got), got[max(0, len(got)-40):])
	}
	if !strings.HasPrefix(got, "2026-03-09 ") {
		t.Fatalf("the first look starts mid-line: %q", got[:40])
	}
	if out.skipped != 0 || !mark.Seen {
		t.Fatalf("skipped %d, mark %+v", out.skipped, mark)
	}
}

// AC3: a log rotated away while the watch looked elsewhere: the end of the rotated file is read first, from where the
// last look stopped, then the new file from its start; nothing written between two looks is missed.
func TestARotatedLogIsFinishedThenTheNewOneIsRead(t *testing.T) {
	t.Parallel()
	path, logs := logFiles(t)
	appendLog(t, path, numbered("old", 0, 3))
	_, _, mark := readAll(t, path, logs, fileMark{})
	appendLog(t, path, numbered("old", 3, 5))
	appendLog(t, filepath.Join(logs, "waveapp.1.log"), numbered("older", 0, 2))
	if err := os.Rename(path, filepath.Join(logs, "waveapp.2.log")); err != nil {
		t.Fatal(err)
	}
	appendLog(t, path, numbered("new", 0, 2))
	got, _, mark := readAll(t, path, logs, mark)
	if want := numbered("old", 3, 5) + numbered("new", 0, 2); got != want {
		t.Fatalf("after rotation read\n%q\nwant\n%q", got, want)
	}
	appendLog(t, path, numbered("new", 2, 3))
	if got, _, _ = readAll(t, path, logs, mark); got != numbered("new", 2, 3) {
		t.Fatalf("after rotation the next look read %q", got)
	}
}

// A rotation that has not created the new file yet: the rotated end is read, and the new file from its start later.
func TestARotationBeforeTheNewFileExists(t *testing.T) {
	t.Parallel()
	path, logs := logFiles(t)
	appendLog(t, path, numbered("old", 0, 2))
	_, _, mark := readAll(t, path, logs, fileMark{})
	appendLog(t, path, numbered("old", 2, 3))
	if err := os.Rename(path, filepath.Join(logs, "waveapp.7.log")); err != nil {
		t.Fatal(err)
	}
	got, _, mark := readAll(t, path, logs, mark)
	if got != numbered("old", 2, 3) {
		t.Fatalf("read %q", got)
	}
	appendLog(t, path, numbered("new", 0, 2))
	if got, _, _ = readAll(t, path, logs, mark); got != numbered("new", 0, 2) {
		t.Fatalf("the new file read %q", got)
	}
}

// A log emptied in place (Clear logs, #2335): shorter than the place reached, or written again past it with another
// start, it is read from its start.
func TestALogEmptiedInPlaceIsReadFromItsStart(t *testing.T) {
	t.Parallel()
	path, logs := logFiles(t)
	appendLog(t, path, numbered("a", 0, 6))
	_, _, mark := readAll(t, path, logs, fileMark{})
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	appendLog(t, path, numbered("b", 0, 1))
	got, _, mark := readAll(t, path, logs, mark)
	if got != numbered("b", 0, 1) {
		t.Fatalf("after a smaller rewrite read %q", got)
	}
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	longer := numbered("c", 0, 10)
	appendLog(t, path, longer)
	if got, _, _ = readAll(t, path, logs, mark); got != longer {
		t.Fatalf("after a longer rewrite read %q", got)
	}
}

// A burst past what one look reads: it keeps the newest part, from a whole line, and says how much it skipped.
func TestABurstIsSkippedToItsNewestPart(t *testing.T) {
	t.Parallel()
	path, logs := logFiles(t)
	appendLog(t, path, numbered("a", 0, 1))
	_, _, mark := readAll(t, path, logs, fileMark{})
	line := stamped(day, "[wavesrv] error: the same burst line again and again")
	burst := strings.Repeat(line, MaxLookBytes/len(line)+1000)
	appendLog(t, path, burst+stamped(day.Add(time.Minute), "[wavesrv] the newest line"))
	got, out, mark := readAll(t, path, logs, mark)
	if int64(len(got)) > MaxLookBytes || !strings.HasPrefix(got, "2026-03-09 ") || !strings.HasSuffix(got, "the newest line\n") {
		t.Fatalf("read %d bytes", len(got))
	}
	if total := out.skipped + out.size(); total != int64(len(burst)+len(stamped(day.Add(time.Minute), "[wavesrv] the newest line"))) {
		t.Fatalf("read %d and skipped %d of %d", out.size(), out.skipped, len(burst))
	}
	if info, _ := os.Stat(path); mark.Offset != info.Size() {
		t.Fatalf("offset %d of %d", mark.Offset, info.Size())
	}
}

// Without a log there is nothing to read, and the look after it starts at the new file's start.
func TestNoLogYet(t *testing.T) {
	t.Parallel()
	path, logs := logFiles(t)
	got, _, mark := readAll(t, path, logs, fileMark{})
	if got != "" || !mark.Seen {
		t.Fatalf("read %q, mark %+v", got, mark)
	}
	appendLog(t, path, numbered("a", 0, 2))
	if got, _, _ = readAll(t, path, logs, mark); got != numbered("a", 0, 2) {
		t.Fatalf("read %q", got)
	}
}

func TestSameFileRule(t *testing.T) {
	t.Parallel()
	cases := []struct {
		mark  fileMark
		ident string
		fp    string
		want  bool
	}{
		{fileMark{Ident: "1:2", Fingerprint: "f"}, "1:2", "f", true},
		{fileMark{Ident: "1:2", Fingerprint: "f"}, "1:3", "f", false},
		{fileMark{Ident: "1:2", Fingerprint: "f"}, "1:2", "g", false},
		{fileMark{Ident: "1:2", Fingerprint: "f"}, "1:2", "", false},
		{fileMark{Ident: "1:2"}, "1:2", "", true},
		{fileMark{Fingerprint: "f"}, "", "f", true},
		{fileMark{Fingerprint: "f"}, "", "g", false},
		{fileMark{}, "", "", false},
	}
	for _, c := range cases {
		if got := sameFile(c.mark, c.ident, c.fp); got != c.want {
			t.Errorf("sameFile(%+v, %q, %q) = %v, want %v", c.mark, c.ident, c.fp, got, c.want)
		}
	}
}
