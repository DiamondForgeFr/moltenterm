// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
)

func TestPostMessageHandlerRefusesChat(t *testing.T) {
	body := `{"chatid": "6f1d2c3e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", "aimode": "openai@gpt", "msg": {"messageid": "m1", "parts": [{"type": "text", "text": "hello"}]}}`
	req := httptest.NewRequest(http.MethodPost, "/api/post-chat-message", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	WaveAIPostMessageHandler(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d: %s", http.StatusForbidden, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), ErrMoltentermNoAI.Error()) {
		t.Fatalf("expected the Moltenterm refusal, got %q", rec.Body.String())
	}
}

func TestPostMessageWrapRefusesChat(t *testing.T) {
	chatOpts := uctypes.WaveChatOpts{
		ChatId: "6f1d2c3e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
		Config: uctypes.AIOptsType{APIType: uctypes.APIType_OpenAIResponses, Model: "gpt", Endpoint: "http://127.0.0.1:9/v1/responses"},
	}
	message := &uctypes.AIMessage{MessageId: "m1", Parts: []uctypes.AIMessagePart{{Type: uctypes.AIMessagePartTypeText, Text: "hello"}}}

	err := WaveAIPostMessageWrap(context.Background(), nil, message, chatOpts)

	if !errors.Is(err, ErrMoltentermNoAI) {
		t.Fatalf("expected ErrMoltentermNoAI, got %v", err)
	}
}
