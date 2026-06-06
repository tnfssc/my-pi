# Setup / auth / config / troubleshoot

Load only for install, init, auth, config, command missing. Do not load for normal ticket view/search.

## Basic checks

```sh
command -v jira
jira version
jira me
jira serverinfo
jira project list
```

Never print tokens, passwords, `.netrc`, full config. If checking config, report exists + non-secret fields only.

Default config often:

```text
$HOME/.config/.jira/.config.yml
```

Override:

```sh
jira issue list -c /path/to/config.yml
JIRA_CONFIG_FILE=/path/to/config.yml jira issue list
```

## Install

GitHub releases + package managers. macOS Homebrew:

```sh
brew install ankitpokhrel/jira-cli/jira-cli
```

Docker try:

```sh
docker run -it --rm ghcr.io/ankitpokhrel/jira-cli:latest
```

Verify:

```sh
jira version
```

Use `jira version`, not `jira --version`.

## Jira Cloud setup

1. Create Atlassian API token.
2. Export token without printing:

```sh
export JIRA_API_TOKEN='...'
```

3. Init:

```sh
jira init
```

4. Choose Cloud. Enter server/user/project.

## Jira Server / Data Center

Basic auth:

```sh
export JIRA_API_TOKEN='your-password-or-token'
jira init
```

PAT / bearer auth:

```sh
export JIRA_API_TOKEN='your-pat'
export JIRA_AUTH_TYPE=bearer
jira init
```

mTLS:

```sh
jira init
```

Choose Local → mTLS. Provide CA cert/client key/client cert.

## Multiple projects / configs

```sh
JIRA_CONFIG_FILE=./local_jira_config.yaml jira issue list
jira issue list -c ./local_jira_config.yaml
jira issue list -p ABC
```

Use `-p KEY` when request names project or default project wrong.

## Troubleshooting

### `jira: command not found`

Install JiraCLI. Check PATH. New shell may be needed.

### Auth fail / 401

- Ensure `JIRA_API_TOKEN` set in same shell.
- Cloud: API token, not account password.
- Server/Data Center PAT: often needs `JIRA_AUTH_TYPE=bearer`.
- Re-run `jira init` if server/user/project changed.

### Wrong project

```sh
jira project list
jira issue list -p ABC --plain
```

Use `-p ABC` or separate config.

### Need completion

```sh
jira completion zsh
jira completion bash
```
