// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// Codex's app-server (https://developers.openai.com/codex/app-server): JSON-RPC 2.0 without the "jsonrpc" field, one
// JSON message per line over stdio. A client sends `initialize`, then the `initialized` notification, then its
// requests; the server rejects any request before that handshake.

const (
	codexAppServerTimeout = 10 * time.Second
	// After stdin closes, the app-server gets this long to exit before its process group is killed.
	codexAppServerExitGrace = 2 * time.Second
	codexMaxLineBytes       = 1024 * 1024
	codexMaxOutputBytes     = 4 * 1024 * 1024

	codexInitializeId = 0
	codexRateLimitsId = 1
)

type codexRpcMessage struct {
	Id     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// RunCodexAppServer runs the user's own `codex app-server`, found on the login PATH as the agents are, for one
// `account/rateLimits/read`. Codex reads its own sign-in; MoltenTerm passes it nothing and reads nothing of it.
func RunCodexAppServer(ctx context.Context) (map[string]any, error) {
	path := molten.LoginPath()
	exe := molten.LookPathIn("codex", path)
	if exe == "" {
		return nil, Unavailable(ReasonFailed)
	}
	return runCodexAppServer(ctx, exe, codexEnv(path))
}

func codexEnv(path string) []string {
	env := make([]string, 0, len(os.Environ())+1)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "PATH=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "PATH="+path)
}

func runCodexAppServer(ctx context.Context, exe string, env []string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, codexAppServerTimeout)
	defer cancel()
	cmd := exec.Command(exe, "app-server")
	cmd.Env = env
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	setProcessGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, Unavailable(ReasonFailed)
	}
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()
	defer func() { endCodexAppServer(cmd, stdin, done, ctx.Err() == nil) }()

	lines := make(chan codexRpcMessage, 16)
	stop := make(chan struct{})
	defer close(stop)
	go readCodexMessages(stdout, lines, stop)
	send := func(msg map[string]any) error {
		data, err := json.Marshal(msg)
		if err != nil {
			return err
		}
		_, err = stdin.Write(append(data, '\n'))
		return err
	}
	init := map[string]any{
		"method": "initialize",
		"id":     codexInitializeId,
		"params": map[string]any{
			"clientInfo": map[string]any{"name": "moltenterm", "title": "MoltenTerm", "version": wavebase.WaveVersion},
		},
	}
	if err := send(init); err != nil {
		return nil, Unavailable(ReasonFailed)
	}
	if _, err := awaitCodexResult(ctx, lines, codexInitializeId); err != nil {
		return nil, err
	}
	if err := send(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return nil, Unavailable(ReasonFailed)
	}
	if err := send(map[string]any{"method": "account/rateLimits/read", "id": codexRateLimitsId}); err != nil {
		return nil, Unavailable(ReasonFailed)
	}
	raw, err := awaitCodexResult(ctx, lines, codexRateLimitsId)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return nil, Unavailable(ReasonFormat)
	}
	return result, nil
}

// endCodexAppServer closes stdin, which ends the app-server, and kills its process group if it lingers: the npm
// `codex` is a launcher whose native child would otherwise outlive it. The group is killed only while its leader is
// not reaped, so its id cannot belong to another program yet. Past the timeout it gets no grace.
func endCodexAppServer(cmd *exec.Cmd, stdin io.Closer, done <-chan struct{}, grace bool) {
	stdin.Close()
	wait := codexAppServerExitGrace
	if !grace {
		wait = 0
	}
	select {
	case <-done:
	case <-time.After(wait):
		killProcessGroup(cmd)
		<-done
	}
}

// readCodexMessages reads the server's lines, each at most codexMaxLineBytes and codexMaxOutputBytes in all, until
// stop closes; a line that is not a JSON-RPC message is skipped, a longer one ends the read.
func readCodexMessages(r io.Reader, out chan<- codexRpcMessage, stop <-chan struct{}) {
	defer close(out)
	scanner := bufio.NewScanner(io.LimitReader(r, codexMaxOutputBytes))
	scanner.Buffer(make([]byte, 0, 64*1024), codexMaxLineBytes)
	for scanner.Scan() {
		var msg codexRpcMessage
		if json.Unmarshal(bytes.TrimSpace(scanner.Bytes()), &msg) != nil {
			continue
		}
		select {
		case out <- msg:
		case <-stop:
			return
		}
	}
}

// awaitCodexResult waits for the response to one request; notifications and the server's own requests are ignored.
func awaitCodexResult(ctx context.Context, lines <-chan codexRpcMessage, id int) (json.RawMessage, error) {
	want := fmt.Sprintf("%d", id)
	for {
		select {
		case <-ctx.Done():
			return nil, Unavailable(ReasonFailed)
		case msg, ok := <-lines:
			if !ok {
				return nil, Unavailable(ReasonFailed)
			}
			if msg.Method != "" || string(bytes.TrimSpace(msg.Id)) != want {
				continue
			}
			if msg.Error != nil {
				return nil, Unavailable(ReasonFailed)
			}
			return msg.Result, nil
		}
	}
}
