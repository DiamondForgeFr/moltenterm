// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
)

// Detection (FR-CONT-006 AC2, AC5, AC6): the agent's program on the login PATH, launchers skipped, and
// `<program> --version` run with the user's environment, no input and a 3 s timeout. Nothing else is executed. The
// result is cached per program path, size and modification time, so opening Continue with… again costs a stat; a
// failed probe is retried after a minute, a successful one after ten (a wrapper script keeps its stat across an
// update). Concurrent callers share one probe per program.

const (
	VersionProbeTimeout = 3 * time.Second
	// A probe whose children keep its output open is given up this long after it ended or timed out.
	probeWaitDelay       = 500 * time.Millisecond
	maxVersionOutput     = 4096
	failedProbeCacheTTL  = time.Minute
	successProbeCacheTTL = 10 * time.Minute
	versionFlag          = "--version"

	ReasonNotFound      = "not found on PATH"
	ReasonProbeTimeout  = "its --version did not answer within %s"
	ReasonProbeFailed   = "its --version failed: %s"
	ReasonNoVersion     = "its --version printed no version"
	ReasonCancelled     = "detection was cancelled"
	maxProbeErrorLength = 160
)

var versionRegex = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?`)
var ansiRegex = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

// Detection is whether an agent can be started. Installed is false when its program is missing or its version probe
// failed; Reason says why. Path is set whenever the program was found.
type Detection struct {
	Installed bool   `json:"installed"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// DetectEnv is where detection looks: the login PATH (molten.LoginPath() in wavesrv, the pane's PATH in wsh), the
// launchers' folder to skip, and the environment the probe runs with (nil: this process's).
type DetectEnv struct {
	PathList    string
	LauncherDir string
	Env         []string
}

// VersionProbe runs `<path> --version` and returns its output.
type VersionProbe func(ctx context.Context, path string, env []string) (string, error)

type detectCacheEntry struct {
	size    int64
	modTime time.Time
	at      time.Time
	result  Detection
}

// probeCall is a probe in flight; done is closed once result is set.
type probeCall struct {
	done   chan struct{}
	result Detection
}

// Detector detects agents and caches the results.
type Detector struct {
	lock     sync.Mutex
	cache    map[string]detectCacheEntry
	inflight map[string]*probeCall
	probe    VersionProbe
	timeout  time.Duration
	now      func() time.Time
}

func MakeDetector(probe VersionProbe, timeout time.Duration) *Detector {
	return &Detector{cache: map[string]detectCacheEntry{}, inflight: map[string]*probeCall{}, probe: probe, timeout: timeout, now: time.Now}
}

// DefaultDetector runs the real probe.
var DefaultDetector = MakeDetector(RunVersionProbe, VersionProbeTimeout)

// begin returns the cached result (cached true), else the probe in flight for the path, else a new probe the caller
// runs (leader true) and ends with finish.
func (d *Detector) begin(path string, info os.FileInfo) (result Detection, cached bool, call *probeCall, leader bool) {
	d.lock.Lock()
	defer d.lock.Unlock()
	if entry, ok := d.cache[path]; ok && entry.size == info.Size() && entry.modTime.Equal(info.ModTime()) {
		ttl := successProbeCacheTTL
		if !entry.result.Installed {
			ttl = failedProbeCacheTTL
		}
		if d.now().Sub(entry.at) < ttl {
			return entry.result, true, nil, false
		}
	}
	if call := d.inflight[path]; call != nil {
		return Detection{}, false, call, false
	}
	call = &probeCall{done: make(chan struct{})}
	d.inflight[path] = call
	return Detection{}, false, call, true
}

func (d *Detector) finish(path string, info os.FileInfo, call *probeCall, result Detection, keep bool) {
	d.lock.Lock()
	defer d.lock.Unlock()
	delete(d.inflight, path)
	if keep {
		d.cache[path] = detectCacheEntry{size: info.Size(), modTime: info.ModTime(), at: d.now(), result: result}
	}
	call.result = result
	close(call.done)
}

func locate(executable string, env DetectEnv) (string, os.FileInfo, bool) {
	path, ok := agentlaunch.FindRealBinary(executable, env.PathList, env.LauncherDir, agentlaunch.IsLauncher)
	if !ok {
		return "", nil, false
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", nil, false
	}
	return path, info, true
}

// Locate finds an agent's program without running it: Installed tells it is on the PATH, with no version.
func Locate(executable string, env DetectEnv) Detection {
	path, _, ok := locate(executable, env)
	if !ok {
		return Detection{Reason: ReasonNotFound}
	}
	return Detection{Installed: true, Path: path}
}

// Detect finds one agent's program and probes its version. It never blocks longer than the probe timeout.
func (d *Detector) Detect(ctx context.Context, executable string, env DetectEnv) Detection {
	path, info, ok := locate(executable, env)
	if !ok {
		return Detection{Reason: ReasonNotFound}
	}
	result, cached, call, leader := d.begin(path, info)
	if cached {
		return result
	}
	if !leader {
		select {
		case <-call.done:
			return call.result
		case <-ctx.Done():
			return Detection{Path: path, Reason: ReasonCancelled}
		}
	}
	result = d.runProbe(ctx, path, env.Env)
	d.finish(path, info, call, result, ctx.Err() == nil)
	return result
}

func (d *Detector) runProbe(ctx context.Context, path string, env []string) Detection {
	probeCtx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()
	out, err := d.probe(probeCtx, path, env)
	if ctx.Err() != nil {
		return Detection{Path: path, Reason: ReasonCancelled}
	}
	if err != nil && errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
		return Detection{Path: path, Reason: fmt.Sprintf(ReasonProbeTimeout, d.timeout)}
	}
	if err != nil {
		return Detection{Path: path, Reason: fmt.Sprintf(ReasonProbeFailed, shortError(err))}
	}
	version := ParseVersion(out)
	if version == "" {
		return Detection{Path: path, Reason: ReasonNoVersion}
	}
	return Detection{Installed: true, Path: path, Version: version}
}

func shortError(err error) string {
	msg := strings.TrimSpace(err.Error())
	if len(msg) > maxProbeErrorLength {
		msg = msg[:maxProbeErrorLength] + "…"
	}
	return msg
}

// ParseVersion finds the version in an agent's --version output: "2.1.292 (Claude Code)", "codex-cli 0.160.1".
func ParseVersion(out string) string {
	return versionRegex.FindString(ansiRegex.ReplaceAllString(out, ""))
}

// DetectAll detects several agents at once, by executable.
func (d *Detector) DetectAll(ctx context.Context, executables []string, env DetectEnv) map[string]Detection {
	rtn := make(map[string]Detection, len(executables))
	var lock sync.Mutex
	var wg sync.WaitGroup
	for _, exe := range executables {
		wg.Add(1)
		go func(exe string) {
			defer wg.Done()
			result := d.Detect(ctx, exe, env)
			lock.Lock()
			defer lock.Unlock()
			rtn[exe] = result
		}(exe)
	}
	wg.Wait()
	return rtn
}

// limitedBuffer keeps the first bytes written to it and drops the rest.
type limitedBuffer struct {
	buf bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.buf.Len(); room > 0 {
		if len(p) > room {
			b.buf.Write(p[:room])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

// RunVersionProbe runs `<path> --version` with no input; on timeout its whole process group is killed.
func RunVersionProbe(ctx context.Context, path string, env []string) (string, error) {
	cmd := exec.CommandContext(ctx, path, versionFlag)
	if env != nil {
		cmd.Env = env
	}
	cmd.Stdin = nil
	out := &limitedBuffer{max: maxVersionOutput}
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.WaitDelay = probeWaitDelay
	setProbeProcessGroup(cmd)
	cmd.Cancel = func() error {
		killProbeProcessGroup(cmd)
		return nil
	}
	err := cmd.Run()
	endProbeLeftovers(cmd)
	return out.buf.String(), err
}
