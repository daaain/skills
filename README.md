# Skills for Claude Code

A collection of AI agent skills for Claude Code (and similar AI coding assistants). Each skill gives your agent specialised knowledge and workflows for specific tasks.

**Contributions welcome!** Found a way to improve a skill or have a new one to add? [Open a PR](#contributing).

## What are Skills?

Skills are markdown files that give AI agents specialised knowledge and workflows for specific tasks. When you add these to your project, Claude Code can recognise when you're working on a relevant task and apply the right frameworks and best practices.

## Available Skills

<!-- SKILLS:START -->
| Skill | Description |
|-------|-------------|
| [devcontainer-security](skills/devcontainer-security/) | Guide for setting up secured VS Code dev containers for coding agents. Use when creating or hardening a DevContainer to... |
<!-- SKILLS:END -->

## Installation

### Option 1: CLI Install (Recommended)

Use [npx skills](https://github.com/vercel-labs/skills) to install skills directly:

```bash
# Install all skills
npx skills add daaain/skills

# Install specific skills
npx skills add daaain/skills --skill devcontainer-security

# List available skills
npx skills add daaain/skills --list
```

This automatically installs to your `.claude/skills/` directory.

### Option 2: Claude Code Plugin

Install via Claude Code's built-in plugin system:

```bash
# Add the marketplace
/plugin marketplace add daaain/skills

# Install all skills
/plugin install skills
```

### Option 3: Clone and Copy

Clone the entire repo and copy the skills folder:

```bash
git clone https://github.com/daaain/skills.git
cp -r skills/skills/* .claude/skills/
```

### Option 4: Git Submodule

Add as a submodule for easy updates:

```bash
git submodule add https://github.com/daaain/skills.git .claude/skills-repo
```

Then reference skills from `.claude/skills-repo/skills/`.

### Option 5: Fork and Customise

1. Fork this repository
2. Customise skills for your specific needs
3. Clone your fork into your projects

### Option 6: SkillKit (Multi-Agent)

Use [SkillKit](https://github.com/rohitg00/skillkit) to install skills across multiple AI agents (Claude Code, Cursor, Copilot, etc.):

```bash
# Install all skills
npx skillkit install daaain/skills

# Install specific skills
npx skillkit install daaain/skills --skill devcontainer-security

# List available skills
npx skillkit install daaain/skills --list
```

## Usage

Once installed, just ask Claude Code for help with tasks covered by the installed skills:

```
"Help me set up a secure dev container for coding agents"
→ Uses devcontainer-security skill
```

You can also invoke skills directly:

```
/devcontainer-security
```

## Contributing

Found a way to improve a skill? Have a new skill to suggest? PRs and issues welcome!

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on adding or improving skills.

## License

[MIT](LICENSE) - Use these however you want.
