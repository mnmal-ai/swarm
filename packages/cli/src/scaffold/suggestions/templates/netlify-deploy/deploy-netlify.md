# Capability: Deploy to Netlify

<!-- DRAFT scaffolded by /prepare-for-swarm (deployment-completion axis). Review every
     command against your actual project before trusting the swarm to run it. Delete the
     steps that don't apply and fill in the project-specific blanks ($IMAGE, $APP, env names). -->

## When this loads

Loaded when a task involves shipping the project to Netlify. The swarm detected this
platform from `netlify.toml` (or an equivalent signal) during onboarding.

## Preconditions

- The Netlify CLI (`netlify`) is installed and authenticated for the target account/project.
- Required deploy credentials are present as environment variables — never inline secrets.
- The working tree is clean and on the branch you intend to ship.
- All tests and the project's verify gate pass locally first. A red build never deploys.

## Build

```sh
netlify build
```

The build step must exit 0 with no errors before moving on.

## Deploy (preview / staged)

```sh
netlify deploy
```

`netlify deploy` publishes a draft/preview URL; `--prod` promotes to the production domain.

## Verify

Confirm a 200 from the draft deploy URL before running the --prod promotion.

Run the `verify-deployment-task.json` checklist before promoting. Treat a failed health
check as a blocking failure — report it and stop; do not promote a broken release.

## Promote (production)

```sh
netlify deploy --prod
```

Promotion is an explicit, separate step. Only run it after verification passes.

## Rollback

Keep the previously-good release identifier handy. Rolling back is re-pointing traffic at
the prior version, not deleting the new one. Document the exact rollback command for this
project here once confirmed.

## Notes

- Record the deployed URL/version and the verify result in the PR description.
- Cost discipline: Netlify usage may be metered — prefer preview/staged deploys over
  repeated production promotions while iterating.
