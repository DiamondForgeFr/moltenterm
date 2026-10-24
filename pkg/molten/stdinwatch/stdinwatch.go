// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package stdinwatch tells wavesrv when its parent (Electron main) is gone (#1043). wavesrv reads its standard input,
// a pipe from Electron, and nothing is ever written to it: EOF means the parent closed it, so wavesrv shuts down.
// Any other read error, such as EBADF when descriptor 0 was closed inside wavesrv while Electron still runs, used to
// shut it down as well and took the whole app, every terminal and agent, with it. Such an error now quits only when
// the parent is gone too; otherwise wavesrv logs it loudly with a goroutine dump and watches the parent instead.
package stdinwatch

import (
	"errors"
	"fmt"
	"io"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	DefaultPollInterval = time.Second
	readBufSize         = 1024
	maxDumpSize         = 64 << 20
)

type Config struct {
	Stdin io.Reader
	// ParentAlive tells whether the parent wavesrv started with still runs. Nil, or a platform where it cannot be told
	// reliably, behaves as before #1043: any read error shuts down.
	ParentAlive  func() bool
	PollInterval time.Duration
	Shutdown     func(reason string)
	Logf         func(format string, args ...any)
	// Dump returns every goroutine's stack (tests replace it).
	Dump func() []byte
	// Fd0State describes what descriptor 0 is now (tests replace it).
	Fd0State func() string
}

// Watch reads cfg.Stdin until the parent is gone, then calls cfg.Shutdown once and returns.
func Watch(cfg Config) {
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = DefaultPollInterval
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if cfg.Dump == nil {
		cfg.Dump = AllStacks
	}
	if cfg.Fd0State == nil {
		cfg.Fd0State = Fd0State
	}
	buf := make([]byte, readBufSize)
	var err error
	for {
		if _, err = cfg.Stdin.Read(buf); err != nil {
			break
		}
	}
	if errors.Is(err, io.EOF) {
		cfg.Shutdown(fmt.Sprintf("stdin closed/error (%v)", err))
		return
	}
	if cfg.ParentAlive == nil || !cfg.ParentAlive() {
		cfg.Shutdown(fmt.Sprintf("stdin closed/error (%v), parent gone", err))
		return
	}
	reportReadError(cfg, err)
	// Descriptor 0 is never read again: once closed, the next file wavesrv opens may get it.
	for {
		time.Sleep(cfg.PollInterval)
		if !cfg.ParentAlive() {
			cfg.Shutdown(fmt.Sprintf("parent exited (stdin had failed earlier: %v)", err))
			return
		}
	}
}

func errnoText(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fmt.Sprintf("errno %d", int(errno))
	}
	return "no errno"
}

func reportReadError(cfg Config, err error) {
	cfg.Logf("molten stdin watch (#1043): reading stdin failed while the parent still runs: %v (%s); descriptor 0 is now: %s. wavesrv keeps running and watches its parent instead. Goroutine dump follows.\n",
		err, errnoText(err), cfg.Fd0State())
	for _, line := range strings.Split(strings.TrimRight(string(cfg.Dump()), "\n"), "\n") {
		cfg.Logf("molten stdin watch dump: %s\n", line)
	}
	cfg.Logf("molten stdin watch: end of goroutine dump\n")
}

// AllStacks is runtime.Stack for every goroutine, grown until it fits.
func AllStacks() []byte {
	size := 1 << 20
	for {
		buf := make([]byte, size)
		n := runtime.Stack(buf, true)
		if n < size || size >= maxDumpSize {
			return buf[:n]
		}
		size *= 2
	}
}
