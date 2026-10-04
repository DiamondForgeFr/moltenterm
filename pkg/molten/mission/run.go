// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

const loginPathMarker = "__MOLTEN_PATH__"
const loginPathTimeout = 8 * time.Second
const maxCommandOutput = 16 << 20

// Runner runs a program in a folder and returns its standard output. Tests inject their own.
type Runner func(ctx context.Context, dir string, name string, args ...string) ([]byte, error)

var loginPathOnce sync.Once
var loginPath string

// A Moltenterm opened from the Finder gets a bare PATH; git, gh and the project's tools are found through the user's
// login shell, read once.
func readLoginPath() string {
	loginPathOnce.Do(func() {
		loginPath = os.Getenv("PATH")
		if runtime.GOOS == "windows" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), loginPathTimeout)
		defer cancel()
		shell := shellutil.DetectLocalShellPath()
		cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", "printf '\\n"+loginPathMarker+"%s\\n' \"$PATH\"")
		cmd.Stdin = nil
		out, err := cmd.Output()
		if err != nil && len(out) == 0 {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			if value, ok := strings.CutPrefix(line, loginPathMarker); ok && value != "" {
				loginPath = value
			}
		}
	})
	return loginPath
}

func commandEnv() []string {
	env := []string{}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "PATH=") {
			continue
		}
		env = append(env, kv)
	}
	// Nothing may wait for a password or a prompt: the collector has no terminal.
	return append(env, "PATH="+readLoginPath(), "GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1")
}

type limitedBuffer struct {
	bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > maxCommandOutput {
		return 0, fmt.Errorf("output larger than %d bytes", maxCommandOutput)
	}
	return b.Buffer.Write(p)
}

// ExecRunner runs programs with the login shell's PATH; the error carries the program's last error line.
func ExecRunner(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	program := lookPathIn(name, readLoginPath())
	if program == "" {
		path, err := exec.LookPath(name)
		if err != nil {
			return nil, &MissingProgramError{Name: name}
		}
		program = path
	}
	// The program is resolved before the command is built: exec.Command looks the bare name up in the process's own
	// PATH and keeps that failure in cmd.Err, which setting cmd.Path afterwards does not clear.
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Dir = dir
	cmd.Env = commandEnv()
	var stdout, stderr limitedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if lines := strings.Split(msg, "\n"); msg != "" {
			msg = lines[len(lines)-1]
		}
		if msg == "" {
			msg = err.Error()
		}
		return stdout.Bytes(), fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), msg)
	}
	return stdout.Bytes(), nil
}

type MissingProgramError struct {
	Name string
}

func (e *MissingProgramError) Error() string {
	return fmt.Sprintf("%s is not installed (or not on the login shell's PATH)", e.Name)
}

func lookPathIn(name string, path string) string {
	for _, dir := range strings.Split(path, string(os.PathListSeparator)) {
		if dir == "" {
			continue
		}
		candidate := dir + string(os.PathSeparator) + name
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			return candidate
		}
	}
	return ""
}
