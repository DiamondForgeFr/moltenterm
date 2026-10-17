// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// MOLTENTERM-PATCH (#805): require a separate caller proof and explicit origin policy.

package authkey

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
)

var authkey string
var callers *CallerPolicy

const WaveAuthKeyEnv = "WAVETERM_AUTH_KEY"
const AuthKeyHeader = "X-AuthKey"

func ValidateIncomingRequest(r *http.Request) error {
	reqAuthKey := r.Header.Get(AuthKeyHeader)
	if reqAuthKey == "" || len(r.Header.Values(AuthKeyHeader)) != 1 {
		return fmt.Errorf("no x-authkey header")
	}
	if subtle.ConstantTimeCompare([]byte(reqAuthKey), []byte(GetAuthKey())) != 1 {
		return fmt.Errorf("x-authkey header is invalid")
	}
	return callers.Validate(r)
}

func SetAuthKeyFromEnv() error {
	authkey = os.Getenv(WaveAuthKeyEnv)
	if authkey == "" {
		return fmt.Errorf("no auth key found in environment variables")
	}
	os.Unsetenv(WaveAuthKeyEnv)
	secret, origin := os.Getenv(CallerSecretEnv), os.Getenv(AppOriginEnv)
	os.Unsetenv(CallerSecretEnv)
	os.Unsetenv(AppOriginEnv)
	var err error
	callers, err = NewCallerPolicy(secret, origin)
	if err != nil {
		return err
	}
	return nil
}

func ValidateRendererRequest(r *http.Request) error {
	if err := ValidateIncomingRequest(r); err != nil {
		return err
	}
	if r.Header.Get(CallerHeader) != "renderer" {
		return fmt.Errorf("application main-frame caller required")
	}
	return nil
}

func AllowsCORS(r *http.Request) bool {
	if len(r.Header.Values("Origin")) != 1 {
		return false
	}
	origin := r.Header.Get("Origin")
	if callers.AllowsPreflight(origin) {
		return true
	}
	// Packaged preflights and responses require the same injected main-frame authority as their actual request.
	// An opaque origin alone is never reflected. Electron's hook authenticates its app's OPTIONS request too.
	return (origin == "null" || origin == "file://") && ValidateRendererRequest(r) == nil
}

func GetAuthKey() string {
	return authkey
}
