# Capability: Deploy to Vercel

<!-- DRAFT scaffolded by /prepare-for-swarm (deployment-completion axis). Review every
     command against your actual project before trusting the swarm to run it. Delete the
     steps that don't apply and fill in the project-specific blanks ($IMAGE, $APP, env names). -->

## When this loads

Loaded when a task involves shipping the project to Vercel. The swarm detected this
platform from `vercel.json` (or an equivalent signal) during onboarding.

## Preconditions

- The Vercel CLI (`vercel`) is installed and authenticated for the target account/project.
- Required deploy credentials are present as environment variables — never inline secrets.
- The working tree is clean and on the branch you intend to ship.
- All tests and the project's verify gate pass locally first. A red build never deploys.

## Build

```sh
vercel build
```

The build step must exit 0 with no errors before moving on.

## Deploy (preview / staged)

```sh
vercel deploy --prebuilt
```

Every deploy produces a unique preview URL; promotion to production is a separate explicit step.

## Verify

Vercel posts the deployment URL as a status check; confirm a 200 from the served URL before promoting.

Run the `verify-deployment-task.json` checklist before promoting. Treat a failed health
check as a blocking failure — report it and stop; do not promote a broken release.

## Promote (production)

```sh
vercel deploy --prebuilt --prod
```

Promotion is an explicit, separate step. Only run it after verification passes.

## Rollback

Keep the previously-good release identifier handy. Rolling back is re-pointing traffic at
the prior version, not deleting the new one. Document the exact rollback command for this
project here once confirmed.

## Notes

- Record the deployed URL/version and the verify result in the PR description.
- Cost discipline: Vercel usage may be metered — prefer preview/staged deploys over
  repeated production promotions while iterating.
