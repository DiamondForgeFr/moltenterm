// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const moltenMcpReexecHelperVar = "MT_MCP_REEXEC_HELPER"

// TestMoltenMcpReexecHelperProcess is the MCP server the tests below run as a program on disk; it does nothing in a
// normal test run.
func TestMoltenMcpReexecHelperProcess(t *testing.T) {
	if os.Getenv(moltenMcpReexecHelperVar) != "1" {
		t.Skip("helper process")
	}
	runMoltenMcpServer(mcpbrowser.BrowserSpec(), moltenMcpBrowserProtocol, os.Getenv(wshutil.WaveJwtTokenVarName))
	os.Exit(0)
}

type lockedBuffer struct {
	lock sync.Mutex
	buf  strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.buf.String()
}

type reexecServer struct {
	t      *testing.T
	prog   string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan string
	stderr *lockedBuffer
}

func copyProgram(t *testing.T, src string, dst string, perm os.FileMode) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, data, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(tmp, perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		t.Fatal(err)
	}
}

// startMcpServerProgram runs a copy of the test binary as `molten mcp browser` against the fake wavesrv.
func startMcpServerProgram(t *testing.T, f *fakeWavesrv) *reexecServer {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// Not named molten: wsh would rewrite the test binary's command line (`molten x` runs as `wsh molten x`).
	prog := filepath.Join(t.TempDir(), "mcp-server")
	copyProgram(t, self, prog, 0755)
	cmd := exec.Command(prog, "-test.run=^TestMoltenMcpReexecHelperProcess$")
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "WAVETERM_") || strings.HasPrefix(kv, "MOLTENTERM_") {
			continue
		}
		cmd.Env = append(cmd.Env, kv)
	}
	cmd.Env = append(cmd.Env, moltenMcpReexecHelperVar+"=1", wshutil.WaveJwtTokenVarName+"="+f.token())
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	s := &reexecServer{t: t, prog: prog, cmd: cmd, stdin: stdin, lines: make(chan string, 100), stderr: &lockedBuffer{}}
	cmd.Stderr = s.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(s.lines)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
		for scanner.Scan() {
			s.lines <- scanner.Text()
		}
	}()
	t.Cleanup(func() {
		stdin.Close()
		done := make(chan struct{})
		go func() {
			cmd.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(time.Minute):
			cmd.Process.Kill()
			<-done
		}
	})
	return s
}

func (s *reexecServer) send(lines ...string) {
	s.t.Helper()
	if _, err := io.WriteString(s.stdin, strings.Join(lines, "\n")+"\n"); err != nil {
		s.t.Fatal(err)
	}
}

// recv returns the next answers by id.
func (s *reexecServer) recv(n int) map[float64]map[string]any {
	s.t.Helper()
	rtn := map[float64]map[string]any{}
	for len(rtn) < n {
		select {
		case line, ok := <-s.lines:
			if !ok {
				s.t.Fatalf("the server ended; stderr:\n%s", s.stderr.String())
			}
			var msg map[string]any
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				s.t.Fatalf("bad line %q", line)
			}
			id, _ := msg["id"].(float64)
			rtn[id] = msg
		case <-time.After(time.Minute):
			s.t.Fatalf("no answer; stderr:\n%s", s.stderr.String())
		}
	}
	return rtn
}

func mcpCallLine(id int, tool string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"%s","arguments":{}}}`, id, tool)
}

func mcpResultText(t *testing.T, msg map[string]any) string {
	t.Helper()
	result, _ := msg["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 || result["isError"] == true {
		t.Fatalf("not a success: %v", msg)
	}
	return content[0].(map[string]any)["text"].(string)
}

func (s *reexecServer) initialized() {
	s.t.Helper()
	s.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"any-mcp-client","version":"1.2.3"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	s.recv(1)
	s.send(mcpCallLine(2, mcpbrowser.ToolTabsContext))
	if text := mcpResultText(s.t, s.recv(1)[2]); text != "ok tabs_context" {
		s.t.Fatalf("first call: %q", text)
	}
}

func TestMoltenMcpServerFollowsANewProgramInPlace(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.start()
	s := startMcpServerProgram(t, f)
	s.initialized()

	copyProgram(t, s.prog, s.prog, 0755)
	// Two calls in one write: the second one is in the server's buffer, or still in the pipe, during the switch.
	s.send(mcpCallLine(3, mcpbrowser.ToolTabsContext), mcpCallLine(4, mcpbrowser.ToolListAgents))
	answers := s.recv(2)
	if text := mcpResultText(t, answers[3]); text != "ok tabs_context" {
		t.Fatalf("call during the switch: %q", text)
	}
	if text := mcpResultText(t, answers[4]); !strings.Contains(text, "Valentin") {
		t.Fatalf("list_agents during the switch: %q", text)
	}
	resumed := "resumed its session in version"
	samePid := fmt.Sprintf("(pid %d)", s.cmd.Process.Pid)
	stderr := s.stderr.String()
	if !strings.Contains(stderr, resumed) || !strings.Contains(stderr, samePid) || strings.Contains(stderr, "keeps running") {
		t.Fatalf("no resume in the same process %d; stderr:\n%s", s.cmd.Process.Pid, stderr)
	}
	if hellos, _ := f.counts(); hellos != 2 {
		t.Fatalf("the new program opens its own session: %d hellos", hellos)
	}
	s.send(mcpCallLine(5, mcpbrowser.ToolTabsContext))
	if text := mcpResultText(t, s.recv(1)[5]); text != "ok tabs_context" {
		t.Fatalf("after the switch: %q", text)
	}
	if strings.Count(s.stderr.String(), "switching to the new version") != 1 {
		t.Fatalf("one switch per change; stderr:\n%s", s.stderr.String())
	}
}

func TestMoltenMcpServerKeepsItsVersionForAProgramOthersCanWrite(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.start()
	s := startMcpServerProgram(t, f)
	s.initialized()

	copyProgram(t, s.prog, s.prog, 0775)
	s.send(mcpCallLine(3, mcpbrowser.ToolTabsContext))
	if text := mcpResultText(t, s.recv(1)[3]); text != "ok tabs_context" {
		t.Fatalf("call after the refused switch: %q", text)
	}
	s.send(mcpCallLine(4, mcpbrowser.ToolTabsContext))
	s.recv(1)
	stderr := s.stderr.String()
	if strings.Count(stderr, "keeps running its current one (it is writable by other accounts") != 1 ||
		!strings.Contains(stderr, "Reconnect this MCP server from the agent") || strings.Contains(stderr, "resumed") {
		t.Fatalf("stderr:\n%s", stderr)
	}
	if hellos, _ := f.counts(); hellos != 1 {
		t.Fatalf("the same session goes on: %d hellos", hellos)
	}
}

func TestMoltenMcpCheckProgramRefusesAnotherOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "molten")
	if err := os.WriteFile(path, []byte("x"), 0755); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := moltenMcpCheckProgram(fi, os.Getuid()); err != nil {
		t.Fatalf("own program: %v", err)
	}
	if err := moltenMcpCheckProgram(fi, os.Getuid()+1); err == nil || !strings.Contains(err.Error(), "another account") {
		t.Fatalf("another owner: %v", err)
	}
	dirFi, _ := os.Stat(filepath.Dir(path))
	if err := moltenMcpCheckProgram(dirFi, os.Getuid()); err == nil {
		t.Fatal("a folder passed")
	}
}

func TestMoltenMcpResumeFileRoundTrip(t *testing.T) {
	state := moltenMcpResumeFile{Format: moltenMcpResumeFormat, Failed: 2,
		Server: mcpbrowser.ResumeState{Initialized: true, ClientName: "any-mcp-client"}}
	pending := []byte("{\"id\":1}\n{\"id\":2}\n")
	got, rest, err := decodeMoltenMcpResume(encodeMoltenMcpResume(state, pending))
	if err != nil || got != state || string(rest) != string(pending) {
		t.Fatalf("got %+v %q %v", got, rest, err)
	}
	if _, _, err := decodeMoltenMcpResume([]byte(`{"format":9}` + "\n")); err == nil {
		t.Fatal("an unknown format was read")
	}
}
