// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func makeTestWsPair(t *testing.T) (*websocket.Conn, <-chan string) {
	t.Helper()
	serverConnCh := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		serverConnCh <- conn
	}))
	t.Cleanup(srv.Close)
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { client.Close() })
	server := <-serverConnCh
	t.Cleanup(func() { server.Close() })
	received := make(chan string, 8)
	go func() {
		for {
			_, msg, err := client.ReadMessage()
			if err != nil {
				return
			}
			received <- string(msg)
		}
	}()
	return server, received
}

func waitForMessage(t *testing.T, received <-chan string, want string) {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case msg := <-received:
			if msg == want {
				return
			}
		case <-timeout:
			t.Fatalf("client never received %s", want)
		}
	}
}

// #223: the deadline a ping leaves behind made the next data write fail with "i/o timeout" on a healthy socket.
func TestStaleWriteDeadlineFailsAWrite(t *testing.T) {
	server, _ := makeTestWsPair(t)
	if err := writeWsText(server, []byte(`{"type":"ping"}`), 50*time.Millisecond); err != nil {
		t.Fatalf("ping write: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	err := server.WriteMessage(websocket.TextMessage, []byte(`{"data":1}`))
	if err == nil || !strings.Contains(err.Error(), "i/o timeout") {
		t.Fatalf("expected an i/o timeout from the stale deadline, got %v", err)
	}
}

func TestWriteWsTextAfterPreviousDeadlineExpired(t *testing.T) {
	server, received := makeTestWsPair(t)
	if err := writeWsText(server, []byte(`{"type":"ping"}`), 50*time.Millisecond); err != nil {
		t.Fatalf("ping write: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := writeWsText(server, []byte(`{"data":1}`), wsWriteWaitTimeout); err != nil {
		t.Fatalf("write after the previous deadline expired: %v", err)
	}
	waitForMessage(t, received, `{"data":1}`)
}
