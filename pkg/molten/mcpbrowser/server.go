// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpbrowser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sync"
)

// The MCP stdio transport (spec 2025-06-18, "Transports"): one JSON-RPC 2.0 message per line, UTF-8, no embedded
// newline; stdout carries only protocol messages. Field names below are the protocol's (camelCase), not MoltenTerm's
// lowercase JSON convention.

const (
	JsonRpcVersion = "2.0"
	ServerName     = "molten-browser"

	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603

	// A tool call's arguments are small; a line longer than this is refused without being buffered whole.
	MaxMessageBytes = 4 << 20
)

// SupportedProtocolVersions, newest first: the client's version is kept when listed, else the newest is offered
// and the client decides (spec, "Lifecycle", version negotiation).
var SupportedProtocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

type ClientInfo struct {
	Name    string
	Version string
}

// Backend carries tool calls to wavesrv. Start is called once, at initialize or at the first call before it.
type Backend interface {
	Start(ctx context.Context, client ClientInfo)
	CallTool(ctx context.Context, tool string, args json.RawMessage) CallResult
	Close()
}

// OfflineBackend answers outside MoltenTerm: the tools are listed, every call fails with ErrNotInMoltenTerm.
type OfflineBackend struct{}

func (OfflineBackend) Start(ctx context.Context, client ClientInfo) {}

func (OfflineBackend) CallTool(ctx context.Context, tool string, args json.RawMessage) CallResult {
	return ErrorResult(ErrNotInMoltenTerm)
}

func (OfflineBackend) Close() {}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type inMessage struct {
	JsonRpc string          `json:"jsonrpc"`
	Id      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type outResponse struct {
	JsonRpc string          `json:"jsonrpc"`
	Id      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type mcpContent struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type mcpToolResult struct {
	Content []mcpContent `json:"content"`
	IsError bool         `json:"isError,omitempty"`
}

type Server struct {
	Version string
	backend Backend
	in      io.Reader
	out     io.Writer

	writeLock sync.Mutex

	lock    sync.Mutex
	started bool
	// closing: stdin closed, so nothing more is written (the client is gone, and stdout may be too).
	closing   bool
	inflight  map[string]*inflightCall
	callGroup sync.WaitGroup
}

type inflightCall struct {
	cancel    context.CancelFunc
	cancelled bool
}

func MakeServer(backend Backend, in io.Reader, out io.Writer, version string) *Server {
	return &Server{Version: version, backend: backend, in: in, out: out, inflight: make(map[string]*inflightCall)}
}

// Serve reads messages until stdin closes (the agent quit or dropped the server), then cancels the calls in flight,
// waits for them and closes the backend, which ends the session in wavesrv.
func (s *Server) Serve(ctx context.Context) error {
	ctx, cancelAll := context.WithCancel(ctx)
	defer func() {
		s.setClosing()
		cancelAll()
		s.callGroup.Wait()
		s.backend.Close()
	}()
	reader := bufio.NewReaderSize(s.in, 64*1024)
	for {
		line, tooLong, err := readLine(reader, MaxMessageBytes)
		if tooLong {
			s.writeError(nil, CodeInvalidRequest, "message too large")
		} else if len(bytes.TrimSpace(line)) > 0 {
			s.handleLine(ctx, line)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// readLine returns the next line without its newline; a line over max is consumed and reported, never kept whole.
func readLine(reader *bufio.Reader, max int) ([]byte, bool, error) {
	var buf []byte
	tooLong := false
	for {
		chunk, err := reader.ReadSlice('\n')
		if !tooLong {
			if len(buf)+len(chunk) > max+1 {
				tooLong = true
				buf = nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if tooLong {
			return nil, true, err
		}
		return bytes.TrimRight(buf, "\r\n"), false, err
	}
}

func (s *Server) handleLine(ctx context.Context, line []byte) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		// Batches were removed from the protocol in 2025-06-18; no client of this server sends them.
		s.writeError(nil, CodeInvalidRequest, "batches are not supported")
		return
	}
	var msg inMessage
	if err := json.Unmarshal(trimmed, &msg); err != nil {
		s.writeError(nil, CodeParseError, "parse error")
		return
	}
	if msg.Method == "" && (len(msg.Result) > 0 || len(msg.Error) > 0) {
		// A response: this server sends no requests, and a response is never answered.
		return
	}
	isRequest := len(msg.Id) > 0 && string(msg.Id) != "null"
	if msg.JsonRpc != JsonRpcVersion || msg.Method == "" {
		if isRequest {
			s.writeError(msg.Id, CodeInvalidRequest, "invalid request")
		}
		// A response (to a request this server never sends) or a malformed notification: nothing to answer.
		return
	}
	if !isRequest {
		s.handleNotification(msg)
		return
	}
	switch msg.Method {
	case "initialize":
		s.handleInitialize(ctx, msg)
	case "ping":
		s.writeResult(msg.Id, map[string]any{})
	case "tools/list":
		s.writeResult(msg.Id, map[string]any{"tools": Tools()})
	case "tools/call":
		s.handleToolCall(ctx, msg)
	default:
		s.writeError(msg.Id, CodeMethodNotFound, fmt.Sprintf("method not found: %s", msg.Method))
	}
}

func (s *Server) handleNotification(msg inMessage) {
	if msg.Method != "notifications/cancelled" {
		return
	}
	var params struct {
		RequestId json.RawMessage `json:"requestId"`
	}
	if json.Unmarshal(msg.Params, &params) != nil || len(params.RequestId) == 0 {
		return
	}
	s.cancelCall(string(params.RequestId))
}

func (s *Server) setClosing() {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.closing = true
}

func (s *Server) isClosing() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.closing
}

func (s *Server) cancelCall(key string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	call := s.inflight[key]
	if call == nil {
		return
	}
	call.cancelled = true
	call.cancel()
}

func negotiateVersion(requested string) string {
	if slices.Contains(SupportedProtocolVersions, requested) {
		return requested
	}
	return SupportedProtocolVersions[0]
}

func (s *Server) handleInitialize(ctx context.Context, msg inMessage) {
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
		ClientInfo      struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"clientInfo"`
	}
	if len(msg.Params) > 0 && json.Unmarshal(msg.Params, &params) != nil {
		s.writeError(msg.Id, CodeInvalidParams, "invalid initialize params")
		return
	}
	s.start(ctx, ClientInfo{Name: params.ClientInfo.Name, Version: params.ClientInfo.Version})
	s.writeResult(msg.Id, map[string]any{
		"protocolVersion": negotiateVersion(params.ProtocolVersion),
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": ServerName, "title": "MoltenTerm browser", "version": s.Version},
		"instructions":    ServerInstructions,
	})
}

func (s *Server) start(ctx context.Context, client ClientInfo) {
	if !s.markStarted() {
		return
	}
	s.backend.Start(ctx, client)
}

func (s *Server) markStarted() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.started {
		return false
	}
	s.started = true
	return true
}

func (s *Server) handleToolCall(ctx context.Context, msg inMessage) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(msg.Params, &params) != nil || params.Name == "" {
		s.writeError(msg.Id, CodeInvalidParams, "invalid tools/call params")
		return
	}
	if !ToolNames()[params.Name] {
		s.writeError(msg.Id, CodeInvalidParams, fmt.Sprintf("unknown tool: %s", params.Name))
		return
	}
	args := bytes.TrimSpace(params.Arguments)
	if len(args) == 0 || string(args) == "null" {
		args = []byte("{}")
	}
	if args[0] != '{' {
		s.writeError(msg.Id, CodeInvalidParams, "tool arguments must be an object")
		return
	}
	key := string(msg.Id)
	callCtx, cancel := context.WithCancel(ctx)
	if !s.registerCall(key, cancel) {
		cancel()
		s.writeError(msg.Id, CodeInvalidRequest, "a request with this id is already running")
		return
	}
	s.start(ctx, ClientInfo{})
	s.callGroup.Add(1)
	go func() {
		defer s.callGroup.Done()
		defer cancel()
		result := s.backend.CallTool(callCtx, params.Name, json.RawMessage(args))
		if s.finishCall(key) {
			// Cancelled by the client: the spec asks for no response.
			return
		}
		s.writeResult(msg.Id, toMcpResult(result))
	}()
}

func (s *Server) registerCall(key string, cancel context.CancelFunc) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.inflight[key] != nil {
		return false
	}
	s.inflight[key] = &inflightCall{cancel: cancel}
	return true
}

// finishCall forgets the call and tells whether the client cancelled it.
func (s *Server) finishCall(key string) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	call := s.inflight[key]
	delete(s.inflight, key)
	return call != nil && call.cancelled
}

func toMcpResult(result CallResult) mcpToolResult {
	rtn := mcpToolResult{Content: make([]mcpContent, 0, len(result.Content)), IsError: result.IsError}
	for _, c := range result.Content {
		rtn.Content = append(rtn.Content, mcpContent{Type: c.Type, Text: c.Text, Data: c.Data, MimeType: c.MimeType})
	}
	if len(rtn.Content) == 0 {
		rtn.Content = append(rtn.Content, mcpContent{Type: ContentText, Text: ""})
	}
	return rtn
}

func (s *Server) writeResult(id json.RawMessage, result any) {
	s.write(outResponse{JsonRpc: JsonRpcVersion, Id: id, Result: result})
}

func (s *Server) writeError(id json.RawMessage, code int, message string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	s.write(outResponse{JsonRpc: JsonRpcVersion, Id: id, Error: &rpcError{Code: code, Message: message}})
}

func (s *Server) write(resp outResponse) {
	if s.isClosing() {
		return
	}
	out, err := json.Marshal(resp)
	if err != nil {
		out, _ = json.Marshal(outResponse{JsonRpc: JsonRpcVersion, Id: resp.Id, Error: &rpcError{Code: CodeInternalError, Message: "internal error"}})
	}
	s.writeLock.Lock()
	defer s.writeLock.Unlock()
	s.out.Write(append(out, '\n'))
}
