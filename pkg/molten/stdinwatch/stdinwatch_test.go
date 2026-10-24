// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package stdinwatch

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// A deadline only bounds a failing run (load-proof tests).
const testDeadline = time.Minute

type fakeParent struct {
	alive atomic.Bool
	polls chan struct{}
}

func makeFakeParent(alive bool) *fakeParent {
	p := &fakeParent{polls: make(chan struct{}, 1024)}
	p.alive.Store(alive)
	return p
}

func (p *fakeParent) check() bool {
	select {
	case p.polls <- struct{}{}:
	default:
	}
	return p.alive.Load()
}

type errReader struct {
	err   error
	reads atomic.Int32
}

func (r *errReader) Read(p []byte) (int, error) {
	r.reads.Add(1)
	return 0, r.err
}

type recorder struct {
	lock    sync.Mutex
	lines   []string
	reasons []string
	dumps   int
}

func (r *recorder) logf(format string, args ...any) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.lines = append(r.lines, fmt.Sprintf(format, args...))
}

func (r *recorder) shutdown(reason string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.reasons = append(r.reasons, reason)
}

func (r *recorder) dump() []byte {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.dumps++
	return []byte("goroutine 1 [running]:\nmain.closer()\n")
}

func (r *recorder) snapshot() ([]string, []string, int) {
	r.lock.Lock()
	defer r.lock.Unlock()
	return append([]string{}, r.lines...), append([]string{}, r.reasons...), r.dumps
}

func startWatch(t *testing.T, stdin io.Reader, alive func() bool, rec *recorder) chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		Watch(Config{Stdin: stdin, ParentAlive: alive, PollInterval: time.Millisecond, Shutdown: rec.shutdown,
			Logf: rec.logf, Dump: rec.dump, Fd0State: func() string { return "not open (test)" }})
	}()
	return done
}

func waitDone(t *testing.T, done chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(testDeadline):
		t.Fatalf("Watch did not return")
	}
}

func ebadf() error {
	return &os.PathError{Op: "read", Path: "/dev/stdin", Err: syscall.EBADF}
}

func TestEOFShutsDown(t *testing.T) {
	rec := &recorder{}
	parent := makeFakeParent(true)
	waitDone(t, startWatch(t, strings.NewReader(""), parent.check, rec))
	_, reasons, dumps := rec.snapshot()
	if len(reasons) != 1 || !strings.Contains(reasons[0], "EOF") {
		t.Fatalf("reasons = %q, want one EOF shutdown", reasons)
	}
	if dumps != 0 {
		t.Fatalf("an EOF dumped the goroutines")
	}
}

func TestReadErrorWithLiveParentKeepsRunning(t *testing.T) {
	rec := &recorder{}
	parent := makeFakeParent(true)
	stdin := &errReader{err: ebadf()}
	done := startWatch(t, stdin, parent.check, rec)
	// The parent is checked once before the dump, then polled: five checks mean the watch went on polling.
	for i := 0; i < 5; i++ {
		select {
		case <-parent.polls:
		case <-time.After(testDeadline):
			t.Fatalf("the parent was not polled")
		}
	}
	lines, reasons, dumps := rec.snapshot()
	if len(reasons) != 0 {
		t.Fatalf("wavesrv shut down while its parent runs: %q", reasons)
	}
	if dumps != 1 {
		t.Fatalf("dumps = %d, want 1", dumps)
	}
	log := strings.Join(lines, "")
	for _, want := range []string{"bad file descriptor", "errno 9", "not open (test)", "dump: main.closer()", "end of goroutine dump"} {
		if !strings.Contains(log, want) {
			t.Fatalf("log lacks %q:\n%s", want, log)
		}
	}
	if n := stdin.reads.Load(); n != 1 {
		t.Fatalf("stdin read %d times after the error, want 1 read", n)
	}
	parent.alive.Store(false)
	waitDone(t, done)
	_, reasons, _ = rec.snapshot()
	if len(reasons) != 1 || !strings.Contains(reasons[0], "parent exited") || !strings.Contains(reasons[0], "bad file descriptor") {
		t.Fatalf("reasons = %q, want one parent-exited shutdown naming the error", reasons)
	}
}

func TestReadErrorWithParentGoneShutsDown(t *testing.T) {
	rec := &recorder{}
	parent := makeFakeParent(false)
	waitDone(t, startWatch(t, &errReader{err: ebadf()}, parent.check, rec))
	_, reasons, dumps := rec.snapshot()
	if len(reasons) != 1 || !strings.Contains(reasons[0], "parent gone") {
		t.Fatalf("reasons = %q, want one parent-gone shutdown", reasons)
	}
	if dumps != 0 {
		t.Fatalf("a gone parent dumped the goroutines")
	}
}

func TestReadErrorWithoutParentCheckShutsDown(t *testing.T) {
	rec := &recorder{}
	waitDone(t, startWatch(t, &errReader{err: ebadf()}, nil, rec))
	_, reasons, _ := rec.snapshot()
	if len(reasons) != 1 || !strings.Contains(reasons[0], "bad file descriptor") {
		t.Fatalf("reasons = %q, want the old shutdown", reasons)
	}
}

func TestAllStacksHoldsEveryGoroutine(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	started := make(chan struct{})
	go func() {
		close(started)
		<-release
	}()
	<-started
	dump := string(AllStacks())
	if !strings.Contains(dump, "TestAllStacksHoldsEveryGoroutine") || strings.Count(dump, "goroutine ") < 2 {
		t.Fatalf("dump lacks the goroutines:\n%s", dump)
	}
}
