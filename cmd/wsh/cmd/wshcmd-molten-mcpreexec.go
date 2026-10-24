// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// An MCP server follows a new MoltenTerm version without a reconnect (#1049, FR-BRW-008): an agent cannot reconnect
// its own MCP server, and a stdio server that exits mid-session is not restarted by its client. Only the MCP standard
// is relied on (one message per line on stdin, the session set up by initialize), so any MCP client keeps its
// session; no client is special-cased. When the program the
// server was started from is replaced on disk, the server re-executes itself in place at an idle point (same process,
// same stdin and stdout), and hands the new program its MCP session and the input it had read but not handled through
// an inherited file (wshcmd-molten-mcpreexec_unix.go).

const (
	moltenMcpResumeFdVar    = "MOLTENTERM_MCP_RESUME_FD"
	moltenMcpResumeProbeVar = "MOLTENTERM_MCP_RESUME_PROBE"
	moltenMcpResumeFormat   = 1
	// moltenMcpResumeProbeReply: what a program that can resume a session prints when probed; an older program, or
	// one that does not start, prints something else.
	moltenMcpResumeProbeReply = "molten-mcp-resume 1"
	// Bounds only a program that hangs: a slow machine still answers within it.
	moltenMcpProbeTimeout   = time.Minute
	moltenMcpMaxResumeBytes = mcpbrowser.MaxMessageBytes + 1<<20
)

// moltenMcpLaunchArgs is the command line the program was started with: wshcmd-molten.go's init rewrites os.Args
// (`molten x` runs as `wsh molten x`), and package variables are set before any init runs. Re-executing with the
// rewritten line would make wsh read `molten` twice.
var moltenMcpLaunchArgs = append([]string{}, os.Args...)

// moltenMcpResumeFile is the first line of the inherited file; the unread input follows it.
type moltenMcpResumeFile struct {
	Format int                    `json:"format"`
	Server mcpbrowser.ResumeState `json:"server"`
	// Failed: calls that failed for want of a link, so the developer's notice (#1029) still comes.
	Failed int `json:"failed,omitempty"`
}

func encodeMoltenMcpResume(state moltenMcpResumeFile, pending []byte) []byte {
	barr, _ := json.Marshal(state)
	rtn := make([]byte, 0, len(barr)+1+len(pending))
	rtn = append(rtn, barr...)
	rtn = append(rtn, '\n')
	return append(rtn, pending...)
}

func decodeMoltenMcpResume(data []byte) (moltenMcpResumeFile, []byte, error) {
	var state moltenMcpResumeFile
	head, pending, found := bytes.Cut(data, []byte("\n"))
	if !found {
		return state, nil, fmt.Errorf("no session line")
	}
	if err := json.Unmarshal(head, &state); err != nil {
		return state, nil, err
	}
	if state.Format != moltenMcpResumeFormat {
		return state, nil, fmt.Errorf("unknown format %d", state.Format)
	}
	return state, pending, nil
}

// readMoltenMcpResume reads the session a previous program of this process handed over, if any. A handover that
// cannot be read still resumes: the client initialized the old program and will not initialize this one.
func readMoltenMcpResume(name string) (moltenMcpResumeFile, []byte, bool) {
	fdText := os.Getenv(moltenMcpResumeFdVar)
	if fdText == "" {
		return moltenMcpResumeFile{}, nil, false
	}
	os.Unsetenv(moltenMcpResumeFdVar)
	fallback := moltenMcpResumeFile{Format: moltenMcpResumeFormat, Server: mcpbrowser.ResumeState{Initialized: true}}
	fd, err := strconv.Atoi(fdText)
	if err != nil || fd < 3 {
		fmt.Fprintf(os.Stderr, "%s: the previous version's session could not be read (fd %q)\n", name, fdText)
		return fallback, nil, true
	}
	file := os.NewFile(uintptr(fd), "molten-mcp-resume")
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, moltenMcpMaxResumeBytes))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: the previous version's session could not be read: %v\n", name, err)
		return fallback, nil, true
	}
	state, pending, err := decodeMoltenMcpResume(data)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: the previous version's session could not be read: %v\n", name, err)
		return fallback, nil, true
	}
	return state, pending, true
}

// moltenMcpEnvWithout is the environment minus the handover's own variables, which only one program may see.
func moltenMcpEnvWithout() []string {
	var rtn []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, moltenMcpResumeFdVar+"=") || strings.HasPrefix(kv, moltenMcpResumeProbeVar+"=") {
			continue
		}
		rtn = append(rtn, kv)
	}
	return rtn
}

// moltenMcpKeptVersionMessage: the server could not switch to the new program and goes on with the one it runs.
func moltenMcpKeptVersionMessage(name string, reason string) string {
	return fmt.Sprintf("%s: a new version is on disk but this server keeps running its current one (%s). Reconnect "+
		"this MCP server from the agent, or start a new agent session, to use it.", name, reason)
}
