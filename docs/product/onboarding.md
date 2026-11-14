# Onboarding

```
curl -fsSL https://<domain>/install.sh | sh   # CLI + agent skill + Claude Code hook
brainiac login                                   # browser sign-in (passkey); --token for CI
brainiac onboard                                 # mode, folder, privacy defaults, hold window
brainiac scan ~/CV.pdf ~/linkedin-export.zip     # read-only preview; nothing leaves the machine
brainiac import                                  # filed as proposals you review
brainiac mcp install                             # wires Claude Code, Claude desktop, Codex, Cursor
brainiac ask "what is my current role and since when?"
```

- **Claude Code plugin**: `/plugin install brainiac@brainiac`; its skill installs the CLI, signs in and wires MCP on first use.
- **Web only**: sign up (with a passkey), add `https://mcp.<domain>` as a connector in claude.ai, drop a CV or LinkedIn export, and say "file my inbox". Your Claude proposes the notes; you review them on the site.
- **Existing vault**: `brainiac import --vault ~/notes` maps OKF types and keeps your files untouched.
