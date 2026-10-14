// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package usage

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeCodexScript is a `codex` that speaks the app-server protocol: it logs what it receives to $FAKE_LOG and answers
// per $FAKE_MODE. It is written once: macOS scans a new executable on its first run, which would skew the timings.
const fakeCodexScript = `#!/bin/sh
[ "$1" = "app-server" ] || exit 2
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$FAKE_LOG"
  case "$line" in
    *'"method":"initialize"'*)
      if [ "$FAKE_MODE" = hang ]; then sleep 600 & echo $! > "$FAKE_LOG.child"; wait; fi
      printf '{"method":"account/updated","params":{}}\nnot json\n{"id":0,"result":{"userAgent":"fake","codexHome":"/nowhere","platformFamily":"unix","platformOs":"macos"}}\n' ;;
    *'"method":"account/rateLimits/read"'*)
      if [ "$FAKE_MODE" = error ]; then
        printf '{"id":1,"error":{"code":-32600,"message":"not signed in"}}\n'
      else
        printf '{"id":7,"result":{}}\n{"method":"server/request","id":1,"params":{}}\n%s\n' "$FAKE_RESULT"
      fi ;;
  esac
done
echo eof > "$FAKE_LOG.eof"
`

var fakeCodexExe string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "molten-fake-codex-")
	if err == nil {
		fakeCodexExe = filepath.Join(dir, "codex")
		if os.WriteFile(fakeCodexExe, []byte(fakeCodexScript), 0o755) == nil {
			runCodexAppServer(context.Background(), fakeCodexExe, []string{"FAKE_LOG=/dev/null", "FAKE_MODE=error"})
		}
	}
	code := m.Run()
	if dir != "" {
		os.RemoveAll(dir)
	}
	os.Exit(code)
}

func fakeCodexEnv(t *testing.T, mode string, result string) ([]string, string) {
	if fakeCodexExe == "" {
		t.Skip("no fake codex")
	}
	log := filepath.Join(t.TempDir(), "received.log")
	env := append(os.Environ(), "FAKE_LOG="+log, "FAKE_MODE="+mode, "FAKE_RESULT="+result)
	return env, log
}

func TestRunCodexAppServerProtocol(t *testing.T) {
	env, log := fakeCodexEnv(t, "ok", `{"id":1,"result":`+appServerResult+`}`)
	result, err := runCodexAppServer(context.Background(), fakeCodexExe, env)
	if err != nil {
		t.Fatal(err)
	}
	// The fake writes this file once its stdin closed, so a run that returned with it ended the app-server by its stdin,
	// not by the kill after the grace. The run's duration is not checked: a loaded machine stretches it at will (#643).
	if _, err := os.Stat(log + ".eof"); err != nil {
		t.Errorf("the app-server ends with its stdin: %v", err)
	}
	snap, err := codexAppServerSnapshot(result, 1)
	if err != nil || snap.Windows[0].UsedPercent != 33 {
		t.Errorf("result: %+v %v", snap, err)
	}
	data, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 {
		t.Fatalf("three messages: %q", lines)
	}
	var init, initialized, read map[string]any
	json.Unmarshal([]byte(lines[0]), &init)
	json.Unmarshal([]byte(lines[1]), &initialized)
	json.Unmarshal([]byte(lines[2]), &read)
	if init["method"] != "initialize" || init["id"] != float64(0) || init["jsonrpc"] != nil {
		t.Errorf("initialize first, no jsonrpc field: %v", init)
	}
	if info, _ := init["params"].(map[string]any)["clientInfo"].(map[string]any); info["name"] != "moltenterm" {
		t.Errorf("clientInfo: %v", init["params"])
	}
	if initialized["method"] != "initialized" || initialized["id"] != nil {
		t.Errorf("then the initialized notification: %v", initialized)
	}
	if read["method"] != "account/rateLimits/read" || read["id"] != float64(1) {
		t.Errorf("then the read: %v", read)
	}
}

func TestRunCodexAppServerErrors(t *testing.T) {
	env, _ := fakeCodexEnv(t, "error", "")
	if _, err := runCodexAppServer(context.Background(), fakeCodexExe, env); err == nil {
		t.Error("an error response fails the read")
	}
	env, _ = fakeCodexEnv(t, "ok", "garbage")
	short, cancelShort := context.WithTimeout(context.Background(), time.Second)
	defer cancelShort()
	if _, err := runCodexAppServer(short, fakeCodexExe, env); err == nil {
		t.Error("no response fails the read")
	}
	if _, err := runCodexAppServer(context.Background(), filepath.Join(t.TempDir(), "codex"), env); err == nil {
		t.Error("no executable")
	}

	// No duration is measured: with a grace longer than the bound below, a run that waited for it would hang there,
	// while a run that kills at once returns right after its timeout, however loaded the machine (#651).
	saved := codexAppServerExitGrace
	codexAppServerExitGrace = time.Hour
	defer func() { codexAppServerExitGrace = saved }()
	env, log := fakeCodexEnv(t, "hang", "")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ended := make(chan error, 1)
	go func() {
		_, err := runCodexAppServer(ctx, fakeCodexExe, env)
		ended <- err
	}()
	select {
	case err := <-ended:
		if err == nil {
			t.Error("a hung app-server fails the read")
		}
	case <-time.After(time.Minute):
		if data, err := os.ReadFile(log + ".child"); err == nil {
			child, _ := strconv.Atoi(strings.TrimSpace(string(data)))
			syscall.Kill(child, syscall.SIGKILL)
		}
		t.Fatal("past its timeout the app-server gets no grace: the run still waits for it")
	}
	data, err := os.ReadFile(log + ".child")
	if err != nil {
		t.Fatal(err)
	}
	child, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	// Generous: it only bounds a failing run. The child sleeps far longer, so its own end cannot pass for the kill.
	deadline := time.Now().Add(time.Minute)
	for {
		if err := syscall.Kill(child, 0); errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadline) {
			syscall.Kill(child, syscall.SIGKILL)
			t.Fatal("the app-server's child process outlived it")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
