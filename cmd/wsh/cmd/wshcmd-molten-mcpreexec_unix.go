// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"golang.org/x/sys/unix"
)

// moltenMcpProgramId tells two programs at one path apart: MoltenTerm installs wsh by a rename at every start, so a
// new install is a new inode.
type moltenMcpProgramId struct {
	dev   uint64
	ino   uint64
	size  int64
	mtime int64
}

type moltenMcpReexec struct {
	name string
	// path: the program this process was started from, the only one it re-executes.
	path  string
	uid   int
	base  moltenMcpProgramId
	tried moltenMcpProgramId
	// failed reads the link's failed-call count at the handover.
	failed func() int
	probe  func(path string) error
	exec   func(path string, argv []string, env []string) error
}

// makeMoltenMcpReexec returns nil when the server cannot know its own program.
func makeMoltenMcpReexec(name string, failed func() int) mcpbrowser.Reexec {
	r := makeMoltenMcpReexecAt(name, failed)
	if r == nil {
		return nil
	}
	return r
}

func makeMoltenMcpReexecAt(name string, failed func() int) *moltenMcpReexec {
	path, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot follow new versions: %v\n", name, err)
		return nil
	}
	fi, err := os.Stat(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: cannot follow new versions: %v\n", name, err)
		return nil
	}
	return &moltenMcpReexec{name: name, path: path, uid: os.Getuid(), base: moltenMcpProgramIdOf(fi), failed: failed,
		probe: moltenMcpProbeProgram, exec: syscall.Exec}
}

func moltenMcpProgramIdOf(fi os.FileInfo) moltenMcpProgramId {
	id := moltenMcpProgramId{size: fi.Size(), mtime: fi.ModTime().UnixNano()}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		id.dev = uint64(st.Dev)
		id.ino = uint64(st.Ino)
	}
	return id
}

func (r *moltenMcpReexec) current() (moltenMcpProgramId, os.FileInfo, bool) {
	fi, err := os.Stat(r.path)
	if err != nil {
		return moltenMcpProgramId{}, nil, false
	}
	return moltenMcpProgramIdOf(fi), fi, true
}

// Changed: the program at the path is not the one running, nor one already tried.
func (r *moltenMcpReexec) Changed() bool {
	id, _, ok := r.current()
	return ok && id != r.base && id != r.tried
}

// moltenMcpCheckProgram is the guardrail on what the server runs in place of itself: a regular file owned by the
// developer, which no other account can have written.
func moltenMcpCheckProgram(fi os.FileInfo, uid int) error {
	if !fi.Mode().IsRegular() {
		return errors.New("it is not a regular file")
	}
	if fi.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("it is writable by other accounts (%v)", fi.Mode().Perm())
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("its owner is unknown")
	}
	if int(st.Uid) != uid {
		return fmt.Errorf("it belongs to another account (uid %d)", st.Uid)
	}
	return nil
}

// moltenMcpProbeProgram runs the new program once, without the agent's input: it must start and say it can resume a
// session, or the server stays as it is (an exec cannot be undone).
func moltenMcpProbeProgram(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), moltenMcpProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path)
	cmd.Args = moltenMcpLaunchArgs
	cmd.Env = append(moltenMcpEnvWithout(), moltenMcpResumeProbeVar+"=1")
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("it did not start: %v", err)
	}
	if string(bytes.TrimSpace(out)) != moltenMcpResumeProbeReply {
		return errors.New("it cannot take over a running session")
	}
	return nil
}

// Exec replaces this process's program with the one now on disk; it returns only when it did not.
func (r *moltenMcpReexec) Exec(state mcpbrowser.ResumeState, pending []byte) error {
	id, fi, ok := r.current()
	if !ok {
		return errors.New("the new program is gone")
	}
	r.tried = id
	err := r.execChecked(fi, state, pending)
	fmt.Fprintf(os.Stderr, "%s\n", moltenMcpKeptVersionMessage(r.name, err.Error()))
	return err
}

func (r *moltenMcpReexec) execChecked(fi os.FileInfo, state mcpbrowser.ResumeState, pending []byte) error {
	if err := moltenMcpCheckProgram(fi, r.uid); err != nil {
		return err
	}
	if err := r.probe(r.path); err != nil {
		return err
	}
	failed := 0
	if r.failed != nil {
		failed = r.failed()
	}
	file, err := os.CreateTemp("", "molten-mcp-resume-*")
	if err != nil {
		return fmt.Errorf("the session could not be saved: %v", err)
	}
	defer file.Close()
	os.Remove(file.Name())
	data := encodeMoltenMcpResume(moltenMcpResumeFile{Format: moltenMcpResumeFormat, Server: state, Failed: failed}, pending)
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("the session could not be saved: %v", err)
	}
	if _, err := file.Seek(0, 0); err != nil {
		return fmt.Errorf("the session could not be saved: %v", err)
	}
	fd := file.Fd()
	// Go opens every file close-on-exec: this one alone must reach the new program.
	if _, err := unix.FcntlInt(fd, unix.F_SETFD, 0); err != nil {
		return fmt.Errorf("the session could not be handed over: %v", err)
	}
	env := append(moltenMcpEnvWithout(), moltenMcpResumeFdVar+"="+strconv.Itoa(int(fd)))
	fmt.Fprintf(os.Stderr, "%s: switching to the new version on disk (pid %d)\n", r.name, os.Getpid())
	err = r.exec(r.path, moltenMcpLaunchArgs, env)
	return fmt.Errorf("it could not be run: %v", err)
}
