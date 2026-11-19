// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

const (
	kimiManagedProvider  = "managed:kimi-code"
	kimiManagedModel     = "kimi-code/"
	kimiManagedOAuthKey  = "oauth/kimi-code"
	kimiManagedOAuthHost = "https://auth.kimi.com"
	kimiManagedBaseURL   = "https://api.kimi.com/coding/v1"
)

type kimiManagedConfig struct {
	DefaultModel string                    `toml:"default_model"`
	Providers    map[string]kimiProvider   `toml:"providers"`
	Models       map[string]kimiModelAlias `toml:"models"`
}

type kimiProvider struct {
	BaseURL string        `toml:"base_url"`
	OAuth   *kimiOAuthRef `toml:"oauth"`
}

type kimiOAuthRef struct {
	Storage   string `toml:"storage"`
	Key       string `toml:"key"`
	OAuthHost string `toml:"oauth_host"`
}

type kimiModelAlias struct {
	Provider string `toml:"provider"`
}

type kimiEnvironment func(string) (string, bool)

func kimiHome(getenv kimiEnvironment, home string) string {
	if dir, ok := getenv("KIMI_CODE_HOME"); ok && dir != "" {
		return dir
	}
	return filepath.Join(home, ".kimi-code")
}

func kimiCredentialPath(getenv kimiEnvironment, home string) string {
	return filepath.Join(kimiHome(getenv, home), "credentials", "kimi-code.json")
}

func kimiConfigPath(getenv kimiEnvironment, home string) string {
	return filepath.Join(kimiHome(getenv, home), "config.toml")
}

func currentKimiCredentialPath() string {
	home, _ := os.UserHomeDir()
	return kimiCredentialPath(os.LookupEnv, home)
}

func kimiCredentialStore() string {
	home, _ := os.UserHomeDir()
	path := kimiCredentialPath(os.LookupEnv, home)
	if dir, ok := os.LookupEnv("KIMI_CODE_HOME"); (ok && dir != "") || home == "" {
		return path
	}
	if strings.HasPrefix(path, home+string(filepath.Separator)) {
		return "~" + path[len(home):]
	}
	return path
}

func normalizeKimiManagedURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func validKimiManagedURL(configured string, defaultValue string, getenv kimiEnvironment, names ...string) bool {
	for _, name := range names {
		if value, ok := getenv(name); ok {
			return normalizeKimiManagedURL(value) == defaultValue
		}
	}
	return configured == "" || normalizeKimiManagedURL(configured) == defaultValue
}

// checkKimiManagedConfigAt decodes no API keys or credential environment entries. Their fields are absent from the
// config structs, and a provider is eligible only through its explicit file-backed OAuth reference.
func checkKimiManagedConfigAt(path string, getenv kimiEnvironment) error {
	data, err := readBoundedRegularFile(path, maxCredentialsBytes)
	if err != nil {
		if errors.Is(err, errNoCredentials) {
			return Unavailable(ReasonSignedOut)
		}
		return err
	}
	var doc kimiManagedConfig
	if _, err := toml.NewDecoder(bytes.NewReader(data)).Decode(&doc); err != nil {
		return Unavailable(ReasonFormat)
	}
	if doc.DefaultModel == "" {
		return Unavailable(ReasonSignedOut)
	}
	alias, ok := doc.Models[doc.DefaultModel]
	if !ok || alias.Provider != kimiManagedProvider || !strings.HasPrefix(doc.DefaultModel, kimiManagedModel) {
		return Unavailable(ReasonUnsupported)
	}
	provider, ok := doc.Providers[kimiManagedProvider]
	if !ok || provider.OAuth == nil || provider.OAuth.Storage != "file" || provider.OAuth.Key != kimiManagedOAuthKey {
		return Unavailable(ReasonUnsupported)
	}
	if !validKimiManagedURL(provider.OAuth.OAuthHost, kimiManagedOAuthHost, getenv, "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST") {
		return Unavailable(ReasonUnsupported)
	}
	if !validKimiManagedURL(provider.BaseURL, kimiManagedBaseURL, getenv, "KIMI_CODE_BASE_URL") {
		return Unavailable(ReasonUnsupported)
	}
	return nil
}

func checkKimiManagedConfiguration() error {
	home, _ := os.UserHomeDir()
	return checkKimiManagedConfigAt(kimiConfigPath(os.LookupEnv, home), os.LookupEnv)
}

func parseKimiCredentials(data []byte) (string, int64, error) {
	var doc struct {
		AccessToken *string  `json:"access_token"`
		ExpiresAt   *float64 `json:"expires_at"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", 0, Unavailable(ReasonFormat)
	}
	if doc.AccessToken == nil || strings.TrimSpace(*doc.AccessToken) == "" {
		return "", 0, Unavailable(ReasonSignedOut)
	}
	token := strings.TrimSpace(*doc.AccessToken)
	if !validBearer(token) {
		return "", 0, Unavailable(ReasonSignedOut)
	}
	if doc.ExpiresAt == nil || *doc.ExpiresAt == 0 {
		return token, 0, nil
	}
	seconds := *doc.ExpiresAt
	if seconds < 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds >= float64(math.MaxInt64)/1000 {
		return "", 0, Unavailable(ReasonFormat)
	}
	milliseconds := seconds * 1000
	if milliseconds >= float64(math.MaxInt64) {
		return "", 0, Unavailable(ReasonFormat)
	}
	return token, int64(milliseconds), nil
}

func readKimiCredentialsFile(path string) (string, int64, error) {
	data, err := readBoundedRegularFile(path, maxCredentialsBytes)
	if err != nil {
		if errors.Is(err, errNoCredentials) {
			return "", 0, Unavailable(ReasonSignedOut)
		}
		return "", 0, err
	}
	defer zero(data)
	return parseKimiCredentials(data)
}

func readKimiCredentials(ctx context.Context) (string, int64, error) {
	return readKimiCredentialsFile(currentKimiCredentialPath())
}
