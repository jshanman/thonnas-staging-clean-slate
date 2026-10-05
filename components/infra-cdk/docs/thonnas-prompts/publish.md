# infra-cdk: Publish

No draft or review. Feature-level `/publish` after the last `/apply-learnings`.

- [ ] Confirm an AWS SSO/profile session for the pipeline env (`AWS_PROFILE`, `aws sso login --profile …`). Do not run generic `aws configure`
- [ ] Run `thonnas infra bootstrap --env <pipeline-env>` (usually `beta`)
- [ ] This package’s `infra.bootstrap` is priority 0 and does not list `applyStrategies` (identity stacks come from cicd `infra.identity.oidc`)
- [ ] If no `infra.bootstrap` contributors exist, skip bootstrap and still open/update the PR

