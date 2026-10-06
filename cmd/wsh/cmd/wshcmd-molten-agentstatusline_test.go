// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"crypto/sha256"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const statusLineInput = `{"session_id":"s1","model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41.2,"resets_at":1738857600}}}`

type recordingSender struct {
	lock sync.Mutex
	reqs []molten.AgentStatusLineRequest
}

func (r *recordingSender) send(req molten.AgentStatusLineRequest) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.reqs = append(r.reqs, req)
}

func (r *recordingSender) all() []molten.AgentStatusLineRequest {
	r.lock.Lock()
	defer r.lock.Unlock()
	return append([]molten.AgentStatusLineRequest(nil), r.reqs...)
}

func runSh(t *testing.T, command string, input string) (string, string, int) {
	t.Helper()
	c := exec.Command("/bin/sh", "-c", command)
	c.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	code := 0
	if err := c.Run(); err != nil {
		ee, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatal(err)
		}
		code = ee.ExitCode()
	}
	return stdout.String(), stderr.String(), code
}

func skipWithoutSh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
}

// The status line the user sees is the one their own command prints: same bytes, same stderr, same exit code.
func TestStatusLineRelayPassesThroughUnchanged(t *testing.T) {
	skipWithoutSh(t)
	commands := []string{
		`input=$(cat); printf '\033[36m%s\033[0m | %s\n' "$(printf '%s' "$input" | wc -c | tr -d ' ')" "it's"`,
		`cat`,
		`printf 'no newline'`,
		`echo out; echo err >&2; exit 7`,
		`printf 'line1\nline2\n'; printf '\t\r\0x' | od -c | head -1`,
	}
	for _, command := range commands {
		wantOut, wantErr, wantCode := runSh(t, command, statusLineInput)
		rec := &recordingSender{}
		var stdout, stderr bytes.Buffer
		code := runStatusLineRelay(strings.NewReader(statusLineInput), &stdout, &stderr, []string{command}, rec.send)
		if stdout.String() != wantOut || stderr.String() != wantErr || code != wantCode {
			t.Errorf("%s:\nwant %q %q %d\ngot  %q %q %d", command, wantOut, wantErr, wantCode, stdout.String(), stderr.String(), code)
		}
		reqs := rec.all()
		if len(reqs) != 1 || reqs[0].FiveHour == nil || reqs[0].FiveHour.UsedPercent != 23.5 || reqs[0].SevenDay.ResetsAt != 1738857600 {
			t.Errorf("%s: sent %+v", command, reqs)
		}
	}
}

func TestStatusLineRelayArgvForm(t *testing.T) {
	skipWithoutSh(t)
	var stdout, stderr bytes.Buffer
	code := runStatusLineRelay(strings.NewReader("abc"), &stdout, &stderr, []string{"/bin/sh", "-c", `cat; echo " $0"`, "zero"}, nil)
	if stdout.String() != "abc zero\n" || code != 0 {
		t.Errorf("argv: %q %d", stdout.String(), code)
	}
	stdout.Reset()
	code = runStatusLineRelay(strings.NewReader(""), &stdout, &stderr, []string{"/nonexistent/statusline", "x"}, nil)
	if code != 127 || stdout.Len() != 0 {
		t.Errorf("missing program: %d %q", code, stdout.String())
	}
}

// An input over the relay's limit is not read for limits, and still reaches the command whole.
func TestStatusLineRelayLargeInput(t *testing.T) {
	skipWithoutSh(t)
	big := statusLineInput + strings.Repeat(" ", molten.StatusLineMaxInput)
	rec := &recordingSender{}
	var stdout, stderr bytes.Buffer
	code := runStatusLineRelay(strings.NewReader(big), &stdout, &stderr, []string{"cat"}, rec.send)
	if code != 0 || sha256.Sum256(stdout.Bytes()) != sha256.Sum256([]byte(big)) {
		t.Errorf("the command gets the whole input: %d bytes of %d", stdout.Len(), len(big))
	}
	if len(rec.all()) != 0 {
		t.Error("an input over 256 KB is not read for limits")
	}
}

func TestStatusLineRelayWithoutCommand(t *testing.T) {
	rec := &recordingSender{}
	var stdout, stderr bytes.Buffer
	if code := runStatusLineRelay(strings.NewReader(statusLineInput), &stdout, &stderr, nil, rec.send); code != 0 {
		t.Errorf("exit %d", code)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 || len(rec.all()) != 1 {
		t.Errorf("prints nothing, sends the limits: %q %q %v", stdout.String(), stderr.String(), rec.all())
	}
	rec = &recordingSender{}
	runStatusLineRelay(strings.NewReader("not json"), &stdout, &stderr, nil, rec.send)
	if reqs := rec.all(); len(reqs) != 1 || !reqs[0].RateLimits || reqs[0].HasWindows() || stdout.Len() != 0 {
		t.Errorf("an unreadable input is reported as unreadable limits: %+v", reqs)
	}
	if code := runStatusLineRelay(strings.NewReader(statusLineInput), &stdout, &stderr, nil, nil); code != 0 || stdout.Len() != 0 {
		t.Error("outside MoltenTerm without a command: nothing")
	}
}

// A slow or stuck hand-off never holds the status line past its timeout, and adds nothing when the command is slower.
func TestStatusLineRelayBoundsTheHandOff(t *testing.T) {
	skipWithoutSh(t)
	stuck := func(molten.AgentStatusLineRequest) { time.Sleep(5 * time.Second) }
	var stdout, stderr bytes.Buffer
	start := time.Now()
	runStatusLineRelay(strings.NewReader(statusLineInput), &stdout, &stderr, []string{"echo hi"}, stuck)
	if d := time.Since(start); d > moltenStatusLineSendTimeout+200*time.Millisecond {
		t.Errorf("a stuck hand-off held the status line %v", d)
	}
	if stdout.String() != "hi\n" {
		t.Errorf("output %q", stdout.String())
	}

	fast := func(molten.AgentStatusLineRequest) {}
	var total time.Duration
	const runs = 10
	for i := 0; i < runs; i++ {
		start = time.Now()
		runStatusLineRelay(strings.NewReader(statusLineInput), &stdout, &stderr, []string{"true"}, fast)
		total += time.Since(start)
	}
	direct := time.Now()
	for i := 0; i < runs; i++ {
		runSh(t, "true", statusLineInput)
	}
	added := (total - time.Since(direct)) / runs
	t.Logf("relay overhead per run: %v", added)
	if added > 20*time.Millisecond {
		t.Errorf("the relay adds %v to the status line (NFR-SHELL-012: under 20 ms)", added)
	}
}

func TestStatusLineSenderOutsideMoltenTerm(t *testing.T) {
	t.Setenv("WAVETERM_JWT", "")
	t.Setenv("WAVETERM_BLOCKID", "")
	if moltenStatusLineSender() != nil {
		t.Error("outside MoltenTerm the relay sends nothing")
	}
	t.Setenv("WAVETERM_JWT", "x")
	if moltenStatusLineSender() != nil {
		t.Error("no block, nothing sent")
	}
}
