**Your SaaSFoundryAI identity.** When a project's instructions ask for your coding-agent identity
(`saasfoundryai agents route --provider <id>`, `sf agents enable <id>`), it is {{SF_AGENT_ID}}. MoltenTerm hands it
to you: `molten agent identity` prints it, and `$MOLTENTERM_SF_AGENT` holds it in the agents and terminals MoltenTerm
starts. Never derive it from your name or your folders: Kimi Code is `kimi`, never `kimi-code`. When neither gives one,
ask the user.
