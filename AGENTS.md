- Any instructions in this file must be VERY concise since this loads in every agent session. Add a short instruction and link out to a more detailed doc.

## Agent skills

This repo uses the tdog engineering skill set; its conventions live under [docs/agents/](docs/agents/) — read [docs/agents/README.md](docs/agents/README.md) first. Specs are GitHub issues on `tylerdurrett/workmachine`.

## Real testing

Fakes prove logic, not integration. Every slice touching an external surface needs a human-watched live demo against the real thing before it's "done" — see [docs/agents/real-testing.md](docs/agents/real-testing.md).

## Sandbox Repo

The sandbox repo used for live GitHub testing of both GitHub issues and workflows lives in a sibling folder to this repo: `../workmachine-sandbox`, and the remote is here: `https://github.com/tylerdurrett/workmachine-sandbox`.