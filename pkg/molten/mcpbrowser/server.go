// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpbrowser

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// ServerSpec is what tells MoltenTerm's stdio MCP servers apart: the browser here, the review session's tools in
// pkg/molten/mcpreview. The protocol, the cancellation and the backend plumbing are the same.
type ServerSpec struct {
	Name         string
	Title        string
	Instructions string
	Tools        []ToolDef
}

// BrowserSpec is `molten mcp browser`: the browser's tools, and the handoff tools (FR-CONT-015).
func BrowserSpec() ServerSpec {
	tools := append(Tools(), AgentTools()...)
	return ServerSpec{Name: ServerName, Title: "MoltenTerm browser", Instructions: ServerInstructions + AgentInstructions(""), Tools: tools}
}

// InstructionsBackend is a backend that completes the server's instructions once started (the agent's first name).
type InstructionsBackend interface {
	Instructions(base string) string
}

func (spec ServerSpec) hasTool(name string) bool {
	for _, t := range spec.Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// ResumeState is the MCP session a server hands to the program that replaces it in the same process (#1049): the
// client sent its initialize to the old program and will not send another.
type ResumeState struct {
	Initialized     bool   `json:"initialized"`
	ProtocolVersion string `json:"protocolversion,omitempty"`
	ClientName      string `json:"clientname,omitempty"`
	ClientVersion   string `json:"clientversion,omitempty"`
	ToolsHash       string `json:"toolshash,omitempty"`
	Resumes         int    `json:"resumes,omitempty"`
}

// Reexec replaces the server's program in place when a new one is on disk (#1049). Changed is asked at every idle
// point and must be cheap; Exec returns only when the replacement did not happen, and the server then goes on.
type Reexec interface {
	Changed() bool
	Exec(state ResumeState, pending []byte) error
}

type Server struct {
	Version string
	spec    ServerSpec
	backend Backend
	in      io.Reader
	out     io.Writer
	reexec  Reexec

	writeLock sync.Mutex

	lock    sync.Mutex
	started bool
	// initialized: an initialize was answered, here or by the program this one replaced.
	initialized     bool
	protocolVersion string
	client          ClientInfo
	resumes         int
	// toolsChanged: resumed in an initialized session that listed other tools.
	toolsChanged bool
	// active: calls not yet answered, counted until their answer is written.
	active int
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
	return MakeSpecServer(BrowserSpec(), backend, in, out, version)
}

func MakeSpecServer(spec ServerSpec, backend Backend, in io.Reader, out io.Writer, version string) *Server {
	return &Server{Version: version, spec: spec, backend: backend, in: in, out: out, inflight: make(map[string]*inflightCall)}
}

// SetReexec lets the server replace its program when a new one is on disk; nil (the default) never does.
func (s *Server) SetReexec(r Reexec) {
	s.reexec = r
}

// Resume starts the server in the session its previous program had: no initialize is awaited, the backend starts
// at the first call with the carried client, and a changed tool list is announced when Serve starts.
func (s *Server) Resume(state ResumeState) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.initialized = state.Initialized
	s.protocolVersion = state.ProtocolVersion
	s.client = ClientInfo{Name: state.ClientName, Version: state.ClientVersion}
	s.resumes = state.Resumes + 1
	s.toolsChanged = state.Initialized && state.ToolsHash != "" && state.ToolsHash != s.spec.toolsHash()
}

// Resumes counts the programs this process ran before the current one.
func (s *Server) Resumes() int {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.resumes
}

func (spec ServerSpec) toolsHash() string {
	barr, _ := json.Marshal(spec.Tools)
	sum := sha256.Sum256(barr)
	return hex.EncodeToString(sum[:])
}

func (s *Server) resumeState() ResumeState {
	s.lock.Lock()
	defer s.lock.Unlock()
	return ResumeState{Initialized: s.initialized, ProtocolVersion: s.protocolVersion, ClientName: s.client.Name,
		ClientVersion: s.client.Version, ToolsHash: s.spec.toolsHash(), Resumes: s.resumes}
}

func (s *Server) toolsChangedOnResume() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.toolsChanged
}

func (s *Server) isIdle() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.active == 0 && !s.closing
}

func (s *Server) addActive(delta int) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.active += delta
}

// tryReexec hands the session and the unread input (the line just read, then what the reader buffered) to a new
// program at an idle point. It returns only when the program stays.
func (s *Server) tryReexec(line []byte, reader *bufio.Reader) {
	if s.reexec == nil {
		return
	}
	s.writeLock.Lock()
	defer s.writeLock.Unlock()
	if !s.isIdle() || !s.reexec.Changed() {
		return
	}
	buffered, _ := reader.Peek(reader.Buffered())
	pending := make([]byte, 0, len(line)+1+len(buffered))
	pending = append(pending, line...)
	pending = append(pending, '\n')
	pending = append(pending, buffered...)
	s.reexec.Exec(s.resumeState(), pending)
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
	if s.toolsChangedOnResume() {
		s.writeNotification("notifications/tools/list_changed")
	}
	reader := bufio.NewReaderSize(s.in, 64*1024)
	for {
		line, tooLong, err := readLine(reader, MaxMessageBytes)
		if tooLong {
			s.writeError(nil, CodeInvalidRequest, "message too large")
		} else if len(bytes.TrimSpace(line)) > 0 {
			// Only a whole line read with nothing else running: no answer owed, no byte of input lost.
			if err == nil {
				s.tryReexec(line, reader)
			}
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
		s.writeResult(msg.Id, map[string]any{"tools": s.spec.Tools})
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
	client := ClientInfo{Name: params.ClientInfo.Name, Version: params.ClientInfo.Version}
	version := negotiateVersion(params.ProtocolVersion)
	s.setInitialized(client, version)
	s.start(ctx, client)
	instructions := s.spec.Instructions
	if ib, ok := s.backend.(InstructionsBackend); ok {
		instructions = ib.Instructions(instructions)
	}
	s.writeResult(msg.Id, map[string]any{
		"protocolVersion": version,
		// listChanged: a program that replaces this one with other tools says so (#1049).
		"capabilities": map[string]any{"tools": map[string]any{"listChanged": true}},
		"serverInfo":   map[string]any{"name": s.spec.Name, "title": s.spec.Title, "version": s.Version},
		"instructions": instructions,
	})
}

func (s *Server) setInitialized(client ClientInfo, version string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.initialized = true
	s.client = client
	s.protocolVersion = version
}

func (s *Server) clientInfo() ClientInfo {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.client
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
	if !s.spec.hasTool(params.Name) {
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
	s.start(ctx, s.clientInfo())
	s.callGroup.Add(1)
	s.addActive(1)
	go func() {
		defer s.callGroup.Done()
		defer cancel()
		result := s.backend.CallTool(callCtx, params.Name, json.RawMessage(args))
		if s.finishCall(key) {
			// Cancelled by the client: the spec asks for no response.
			s.addActive(-1)
			return
		}
		s.writeLine(s.marshal(outResponse{JsonRpc: JsonRpcVersion, Id: msg.Id, Result: toMcpResult(result)}), true)
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

func (s *Server) writeNotification(method string) {
	out, _ := json.Marshal(map[string]any{"jsonrpc": JsonRpcVersion, "method": method})
	s.writeLine(out, false)
}

func (s *Server) write(resp outResponse) {
	s.writeLine(s.marshal(resp), false)
}

func (s *Server) marshal(resp outResponse) []byte {
	out, err := json.Marshal(resp)
	if err != nil {
		out, _ = json.Marshal(outResponse{JsonRpc: JsonRpcVersion, Id: resp.Id, Error: &rpcError{Code: CodeInternalError, Message: "internal error"}})
	}
	return out
}

// writeLine writes one message. callDone: the answer of a call, which stops counting as running under the write
// lock, before the client can read it: a handover, which holds that lock, sees every call either running or answered.
func (s *Server) writeLine(out []byte, callDone bool) {
	s.writeLock.Lock()
	defer s.writeLock.Unlock()
	if callDone {
		s.addActive(-1)
	}
	if s.isClosing() {
		return
	}
	s.out.Write(append(out, '\n'))
}
