# Contributing to Envoy

Thanks for your interest in contributing to Envoy!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Copy `.env.example` to `.env.local` and fill in your values
4. Install dependencies: `npm install`
5. Run migrations: `npm run migrate`
6. Start the dev server: `npm run dev`

## Development

- **TypeScript** is checked during build (`npx next build`)
- **Tailwind 4** for styling with shadcn/ui components
- **Zod v3** for all request/response validation

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Ensure the build passes: `npx next build`
4. Submit a pull request

## Project Conventions

- API routes live in `app/api/v1/<resource>/route.ts`
- Database queries go in `lib/queries/<resource>.ts`
- Schemas are centralized in `lib/schemas.ts`
- Every database query must include `WHERE organization_id = ${orgId}` for tenant isolation
- Use the `requireAdmin` + `isErrorResponse` auth guard pattern in API routes

## Adding Database Migrations

Create a new SQL file in `migrations/` with the next sequential number (e.g., `038_description.sql`). Run with `npm run migrate`.

## Reporting Issues

Please open an issue on GitHub with:
- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
