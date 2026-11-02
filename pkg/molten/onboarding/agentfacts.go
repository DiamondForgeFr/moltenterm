// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import "github.com/wavetermdev/waveterm/pkg/molten"

// The agents' plain-words profiles (FR-ONB-008 AC-4, #1697), shown on the Library's agent pages (#1699) and, later,
// by Help me choose on the first launch: the one source, next to the install catalog. Every fact comes from the
// vendor's official pages (#1697's research, checked on CheckedOn); sentences are i18n keys of
// library.agents.profiles.<id> in en.json and fr.json, model families, plan names, prices and currencies are data,
// never translated. Prices are as the vendor's page shows them, never converted. Nothing is fetched at run time.

// AgentPrice is the cheapest plan that unlocks the CLI. Amount is empty when the vendor does not state it.
type AgentPrice struct {
	Amount   string `json:"amount,omitempty"`
	Currency string `json:"currency,omitempty"`
	Period   string `json:"period,omitempty"`
	Plan     string `json:"plan,omitempty"`
	NoteKey  string `json:"notekey,omitempty"`
}

type AgentFacts struct {
	CheckedOn   string `json:"checkedon"`
	Site        string `json:"-"`
	Docs        string `json:"-"`
	PricingPage string `json:"pricingpage,omitempty"`
	ModelsPage  string `json:"modelspage,omitempty"`
	// "yes", "no" or "notstated": a free plan that runs the CLI.
	FreeTier     string      `json:"freetier,omitempty"`
	From         *AgentPrice `json:"from,omitempty"`
	Models       []string    `json:"models,omitempty"`
	GoodForKey   string      `json:"goodforkey,omitempty"`
	StrengthKeys []string    `json:"strengthkeys,omitempty"`
	WeakKeys     []string    `json:"weakkeys,omitempty"`
	SpeedKey     string      `json:"speedkey,omitempty"`
	LimitsKey    string      `json:"limitskey,omitempty"`
	// A neutral note the page links (Antigravity's terms on third-party apps).
	NoteKey  string `json:"notekey,omitempty"`
	NotePage string `json:"notepage,omitempty"`
	// writing, research, images, voice: "yes", "no" or "notstated".
	BeyondCode map[string]string `json:"beyondcode,omitempty"`
	// Help me choose's data (choice.json of #1697): the uses the vendor states, the subscriptions that include it.
	Uses       []string `json:"uses,omitempty"`
	IncludedIn []string `json:"includedin,omitempty"`
	Sources    []string `json:"sources,omitempty"`
}

var agentFactsCatalog = map[string]AgentFacts{
	molten.AgentIdAntigravity: {
		CheckedOn:    "2026-11-01",
		Site:         "https://antigravity.google",
		Docs:         "https://antigravity.google/docs/getting-started?tab=cli",
		PricingPage:  "https://antigravity.google/pricing",
		ModelsPage:   "https://antigravity.google/docs/models",
		FreeTier:     "yes",
		From:         &AgentPrice{Amount: "19.99", Currency: "USD", Period: "month", Plan: "Google AI Pro", NoteKey: "library.agents.profiles.antigravity.billing"},
		Models:       []string{"Gemini", "Claude", "GPT-OSS"},
		GoodForKey:   "library.agents.profiles.antigravity.goodFor",
		StrengthKeys: []string{"library.agents.profiles.antigravity.s1", "library.agents.profiles.antigravity.s2", "library.agents.profiles.antigravity.s3"},
		WeakKeys:     []string{"library.agents.profiles.antigravity.w1", "library.agents.profiles.antigravity.w2"},
		SpeedKey:     "library.agents.profiles.antigravity.speed",
		LimitsKey:    "library.agents.profiles.antigravity.limits",
		NoteKey:      "library.agents.profiles.antigravity.note",
		NotePage:     "https://antigravity.google/docs/faq",
		BeyondCode:   map[string]string{"writing": "yes", "research": "yes", "images": "yes", "voice": "yes"},
		Uses:         []string{"code", "write-research", "first-try"},
		IncludedIn:   []string{"google-ai"},
		Sources:      []string{"https://aistudio.google.com/app/api-keys", "https://antigravity.google", "https://antigravity.google/cli/install.cmd", "https://antigravity.google/cli/install.ps1", "https://antigravity.google/cli/install.sh", "https://antigravity.google/docs/cli", "https://antigravity.google/docs/cli/gcli-migration", "https://antigravity.google/docs/cli/reference/", "https://antigravity.google/docs/cli/troubleshooting/", "https://antigravity.google/docs/faq", "https://antigravity.google/docs/getting-started?tab=cli", "https://antigravity.google/docs/install/"},
	},
	"claude-code": {
		CheckedOn:    "2026-11-01",
		Site:         "https://code.claude.com/docs/en/overview",
		Docs:         "https://code.claude.com/docs/en/quickstart",
		PricingPage:  "https://claude.com/pricing",
		ModelsPage:   "https://platform.claude.com/docs/en/about-claude/models/overview",
		FreeTier:     "no",
		From:         &AgentPrice{Amount: "20", Currency: "USD", Period: "month", Plan: "Pro", NoteKey: "library.agents.profiles.claude-code.billing"},
		Models:       []string{"Claude Opus", "Claude Sonnet", "Claude Haiku", "Claude Fable"},
		GoodForKey:   "library.agents.profiles.claude-code.goodFor",
		StrengthKeys: []string{"library.agents.profiles.claude-code.s1", "library.agents.profiles.claude-code.s2", "library.agents.profiles.claude-code.s3"},
		WeakKeys:     []string{"library.agents.profiles.claude-code.w1", "library.agents.profiles.claude-code.w2"},
		SpeedKey:     "library.agents.profiles.claude-code.speed",
		LimitsKey:    "library.agents.profiles.claude-code.limits",
		BeyondCode:   map[string]string{"writing": "yes", "research": "yes", "images": "notstated", "voice": "yes"},
		Uses:         []string{"code", "write-research"},
		IncludedIn:   []string{"claude"},
		Sources:      []string{"https://claude.ai/install.cmd", "https://claude.ai/install.ps1", "https://claude.ai/install.sh", "https://claude.ai/login", "https://claude.com/pricing", "https://code.claude.com/docs/en/authentication", "https://code.claude.com/docs/en/overview", "https://code.claude.com/docs/en/quickstart", "https://code.claude.com/docs/en/setup", "https://code.claude.com/docs/en/setup#authenticate", "https://code.claude.com/docs/en/setup#remove-configuration-files", "https://code.claude.com/docs/en/setup#uninstall-claude-code"},
	},
	"codex": {
		CheckedOn:    "2026-11-01",
		Site:         "https://developers.openai.com/codex",
		Docs:         "https://learn.chatgpt.com/docs/codex/cli",
		PricingPage:  "https://learn.chatgpt.com/docs/pricing",
		ModelsPage:   "https://learn.chatgpt.com/docs/models",
		FreeTier:     "yes",
		From:         &AgentPrice{Amount: "8", Currency: "USD", Period: "month", Plan: "ChatGPT Go", NoteKey: "library.agents.profiles.codex.billing"},
		Models:       []string{"GPT Astra", "GPT Sol", "GPT Terra", "GPT Luna"},
		GoodForKey:   "library.agents.profiles.codex.goodFor",
		StrengthKeys: []string{"library.agents.profiles.codex.s1", "library.agents.profiles.codex.s2", "library.agents.profiles.codex.s3"},
		WeakKeys:     []string{"library.agents.profiles.codex.w1", "library.agents.profiles.codex.w2"},
		SpeedKey:     "library.agents.profiles.codex.speed",
		LimitsKey:    "library.agents.profiles.codex.limits",
		BeyondCode:   map[string]string{"writing": "yes", "research": "yes", "images": "yes", "voice": "yes"},
		Uses:         []string{"code", "write-research", "first-try"},
		IncludedIn:   []string{"chatgpt"},
		Sources:      []string{"https://chatgpt.com/codex/install.ps1", "https://chatgpt.com/codex/install.sh", "https://chatgpt.com/pricing/", "https://developers.openai.com/api/docs/supported-countries", "https://developers.openai.com/codex", "https://developers.openai.com/codex/auth", "https://developers.openai.com/codex/cli", "https://developers.openai.com/codex/config-advanced", "https://developers.openai.com/codex/pricing", "https://github.com/openai/codex", "https://github.com/openai/codex#readme", "https://github.com/openai/codex/blob/main/docs/install.md"},
	},
	molten.AgentIdCopilot: {
		CheckedOn:    "2026-11-01",
		Site:         "https://github.com/features/copilot/cli",
		Docs:         "https://docs.github.com/en/copilot/how-tos/copilot-cli",
		PricingPage:  "https://github.com/features/copilot/plans",
		ModelsPage:   "https://github.com/features/copilot/plans",
		FreeTier:     "yes",
		From:         &AgentPrice{Amount: "10", Currency: "USD", Period: "month", Plan: "Copilot Pro", NoteKey: "library.agents.profiles.copilot.billing"},
		Models:       []string{"Claude", "GPT", "Gemini", "Grok", "Kimi", "MAI"},
		GoodForKey:   "library.agents.profiles.copilot.goodFor",
		StrengthKeys: []string{"library.agents.profiles.copilot.s1", "library.agents.profiles.copilot.s2", "library.agents.profiles.copilot.s3"},
		WeakKeys:     []string{"library.agents.profiles.copilot.w1", "library.agents.profiles.copilot.w2"},
		SpeedKey:     "library.agents.profiles.copilot.speed",
		LimitsKey:    "library.agents.profiles.copilot.limits",
		BeyondCode:   map[string]string{"writing": "notstated", "research": "notstated", "images": "notstated", "voice": "notstated"},
		Uses:         []string{"code", "first-try"},
		IncludedIn:   []string{"github-copilot"},
		Sources:      []string{"https://docs.github.com/copilot/how-tos/manage-your-account/free-access-with-copilot-student", "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli", "https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing", "https://docs.github.com/en/copilot/get-started/plans", "https://docs.github.com/en/copilot/how-tos/copilot-cli", "https://docs.github.com/en/copilot/how-tos/copilot-cli/administer-copilot-cli-for-your-enterprise", "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli", "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli", "https://docs.github.com/en/copilot/how-tos/manage-your-account/get-free-access-to-copilot-pro", "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli", "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing", "https://docs.github.com/en/site-policy/other-site-policies/github-and-trade-controls"},
	},
	molten.AgentIdCursor: {
		CheckedOn:    "2026-11-01",
		Site:         "https://cursor.com/cli",
		Docs:         "https://cursor.com/docs/cli/overview",
		PricingPage:  "https://cursor.com/en/pricing",
		ModelsPage:   "https://cursor.com/docs/models",
		FreeTier:     "notstated",
		From:         &AgentPrice{Amount: "8", Currency: "USD", Period: "month", Plan: "Plus (The X Subscription)", NoteKey: "library.agents.profiles.cursor.billing"},
		Models:       []string{"Composer", "Grok", "Claude", "GPT", "Gemini", "DeepSeek", "Kimi", "GLM"},
		GoodForKey:   "library.agents.profiles.cursor.goodFor",
		StrengthKeys: []string{"library.agents.profiles.cursor.s1", "library.agents.profiles.cursor.s2", "library.agents.profiles.cursor.s3"},
		WeakKeys:     []string{"library.agents.profiles.cursor.w1", "library.agents.profiles.cursor.w2"},
		SpeedKey:     "library.agents.profiles.cursor.speed",
		LimitsKey:    "library.agents.profiles.cursor.limits",
		BeyondCode:   map[string]string{"writing": "yes", "research": "notstated", "images": "yes", "voice": "yes"},
		Uses:         []string{"code"},
		IncludedIn:   []string{"x-subscription", "cursor"},
		Sources:      []string{"https://cursor.com/cli", "https://cursor.com/dashboard", "https://cursor.com/docs/cli/installation", "https://cursor.com/docs/cli/overview", "https://cursor.com/docs/cli/reference/authentication", "https://cursor.com/docs/cli/reference/configuration", "https://cursor.com/docs/models", "https://cursor.com/en/pricing", "https://cursor.com/help/account-and-billing/pricing", "https://cursor.com/help/integrations/cli", "https://cursor.com/help/security-and-privacy/regions", "https://cursor.com/install"},
	},
	molten.AgentIdGrok: {
		CheckedOn:    "2026-11-01",
		Site:         "https://x.ai/build",
		Docs:         "https://docs.x.ai/build/overview",
		PricingPage:  "https://x.ai/pricing",
		ModelsPage:   "https://docs.x.ai/developers/models/grok-4.7",
		FreeTier:     "notstated",
		From:         &AgentPrice{Amount: "", Currency: "USD", Period: "month", NoteKey: "library.agents.profiles.grok.billing"},
		Models:       []string{"Grok", "Grok Build", "local models"},
		GoodForKey:   "library.agents.profiles.grok.goodFor",
		StrengthKeys: []string{"library.agents.profiles.grok.s1", "library.agents.profiles.grok.s2", "library.agents.profiles.grok.s3"},
		WeakKeys:     []string{"library.agents.profiles.grok.w1", "library.agents.profiles.grok.w2"},
		SpeedKey:     "library.agents.profiles.grok.speed",
		LimitsKey:    "library.agents.profiles.grok.limits",
		BeyondCode:   map[string]string{"writing": "yes", "research": "notstated", "images": "yes", "voice": "yes"},
		Uses:         []string{"code"},
		IncludedIn:   []string{"x-subscription", "supergrok"},
		Sources:      []string{"https://console.x.ai", "https://docs.x.ai/build/overview", "https://docs.x.ai/developers/models/grok-4.7", "https://docs.x.ai/developers/models/grok-build-0.1", "https://docs.x.ai/developers/pricing", "https://docs.x.ai/grok/faq", "https://docs.x.ai/grok/overview", "https://github.com/xai-org/grok-build", "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md", "https://grok.com", "https://grok.com/supergrok?referrer=grok-build", "https://x.ai/build"},
	},
	"kimi": {
		CheckedOn:    "2026-11-01",
		Site:         "https://www.kimi.com/code",
		Docs:         "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started",
		PricingPage:  "https://www.kimi.ai/help/membership/membership-pricing",
		ModelsPage:   "https://www.kimi.com/code/docs/third-party-tools/claude-code.html",
		FreeTier:     "no",
		From:         &AgentPrice{Amount: "19", Currency: "USD", Period: "month", Plan: "Plus", NoteKey: "library.agents.profiles.kimi.billing"},
		Models:       []string{"Kimi K3", "Kimi for Coding"},
		GoodForKey:   "library.agents.profiles.kimi.goodFor",
		StrengthKeys: []string{"library.agents.profiles.kimi.s1", "library.agents.profiles.kimi.s2", "library.agents.profiles.kimi.s3"},
		WeakKeys:     []string{"library.agents.profiles.kimi.w1", "library.agents.profiles.kimi.w2"},
		SpeedKey:     "library.agents.profiles.kimi.speed",
		LimitsKey:    "library.agents.profiles.kimi.limits",
		BeyondCode:   map[string]string{"writing": "yes", "research": "yes", "images": "notstated", "voice": "notstated"},
		Uses:         []string{"code", "write-research"},
		IncludedIn:   []string{"kimi"},
		Sources:      []string{"https://api.kimi.ai/coding/", "https://api.kimi.com/coding/", "https://code.kimi.com/kimi-code/install.ps1", "https://code.kimi.com/kimi-code/install.sh", "https://github.com/MoonshotAI/kimi-cli", "https://github.com/roomedia/ax-trend/issues/3498", "https://www.kimi.ai/blog/kimi-k3-1-pro", "https://www.kimi.ai/code/#pricing", "https://www.kimi.ai/help/membership/membership-pricing", "https://www.kimi.com/code", "https://www.kimi.com/code/console", "https://www.kimi.com/code/docs/"},
	},
	molten.AgentIdVibe: {
		CheckedOn:    "2026-11-01",
		Site:         "https://mistral.ai/products/vibe/code/",
		Docs:         "https://docs.mistral.ai/vibe/code/overview",
		PricingPage:  "https://mistral.ai/pricing",
		ModelsPage:   "https://docs.mistral.ai/vibe/code/cli/configuration",
		FreeTier:     "yes",
		From:         &AgentPrice{Amount: "14.99", Currency: "USD", Period: "month", Plan: "Pro", NoteKey: "library.agents.profiles.vibe.billing"},
		Models:       []string{"Mistral Medium", "Devstral"},
		GoodForKey:   "library.agents.profiles.vibe.goodFor",
		StrengthKeys: []string{"library.agents.profiles.vibe.s1", "library.agents.profiles.vibe.s2", "library.agents.profiles.vibe.s3"},
		WeakKeys:     []string{"library.agents.profiles.vibe.w1", "library.agents.profiles.vibe.w2"},
		SpeedKey:     "library.agents.profiles.vibe.speed",
		LimitsKey:    "library.agents.profiles.vibe.limits",
		BeyondCode:   map[string]string{"writing": "yes", "research": "yes", "images": "yes", "voice": "yes"},
		Uses:         []string{"code", "write-research", "first-try"},
		IncludedIn:   []string{"mistral"},
		Sources:      []string{"https://astral.sh/uv/install.ps1", "https://chat.mistral.ai/code/extensions", "https://console.mistral.ai", "https://docs.mistral.ai/le-chat/content-creation/image-generation", "https://docs.mistral.ai/le-chat/conversation/voice-mode", "https://docs.mistral.ai/mistral-vibe/introduction", "https://docs.mistral.ai/models/devstral-2-25-12", "https://docs.mistral.ai/vibe/code/cli/configuration", "https://docs.mistral.ai/vibe/code/cli/install-setup", "https://docs.mistral.ai/vibe/code/overview", "https://github.com/mistralai/mistral-vibe", "https://mistral.ai/news/mistral-vibe-2-0"},
	},
	"qwen-code": {
		CheckedOn:    "2026-11-01",
		Site:         "https://github.com/QwenLM/qwen-code",
		Docs:         "https://qwenlm.github.io/qwen-code-docs/en/users/overview",
		PricingPage:  "https://www.qwencloud.com/pricing/token-plan",
		ModelsPage:   "https://docs.modelstudio.console.alibabacloud.com/en/model-studio/coding-plan",
		FreeTier:     "no",
		From:         &AgentPrice{Amount: "6", Currency: "USD", Period: "month", Plan: "QwenCloud Token Plan Lite", NoteKey: "library.agents.profiles.qwen-code.billing"},
		Models:       []string{"Qwen Plus", "Qwen Max", "Qwen Coder"},
		GoodForKey:   "library.agents.profiles.qwen-code.goodFor",
		StrengthKeys: []string{"library.agents.profiles.qwen-code.s1", "library.agents.profiles.qwen-code.s2", "library.agents.profiles.qwen-code.s3"},
		WeakKeys:     []string{"library.agents.profiles.qwen-code.w1", "library.agents.profiles.qwen-code.w2"},
		SpeedKey:     "library.agents.profiles.qwen-code.speed",
		LimitsKey:    "library.agents.profiles.qwen-code.limits",
		BeyondCode:   map[string]string{"writing": "notstated", "research": "notstated", "images": "yes", "voice": "yes"},
		Uses:         []string{"code"},
		IncludedIn:   []string{"qwencloud"},
		Sources:      []string{"https://bailian.console.aliyun.com", "https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3005961", "https://docs.modelstudio.console.alibabacloud.com/en/model-studio/coding-plan", "https://docs.qwencloud.com/developer-guides/getting-started/model-prices", "https://docs.qwencloud.com/token-plan/overview", "https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview", "https://github.com/QwenLM/qwen-code", "https://modelstudio.console.alibabacloud.com", "https://modelstudio.console.alibabacloud.com/?tab=doc#/doc/?type=model&url=2840914", "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1", "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh", "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/uninstall-qwen-standalone.ps1"},
	},
}
