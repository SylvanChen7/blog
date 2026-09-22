# Project Guidelines

This is a personal blog built with Astro and the AstroPaper theme. Tailor changes to the needs of this personal blog and follow the existing theme structure.

## Development and Build

- Before installing dependencies, starting the development server, building, or previewing the site, consult the “Running Locally” and “Commands” sections of [README.md](README.md). Use the documented pnpm commands from the project root.
- This repository is already initialized. Start with `pnpm install` to prepare the environment, use `pnpm run dev` for development, and use `pnpm run build` for production builds.
- Use the local pnpm workflow. Docker operations are currently out of scope.
- When changes affect site content or runtime behavior, validate them with `pnpm run build`. Validation passes only when the build succeeds; explain the cause of any failure. Run other checks as appropriate for the changes, using the pnpm commands in the README.
