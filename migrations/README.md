# Database Migrations

This folder contains versioned database migrations managed by Drizzle ORM.

## Generating Migrations

When you make changes to the schema in `shared/schema.ts`, generate a new migration:

```bash
npm run db:generate
```

This will create a new migration file in this folder.

## Running Migrations

Migrations are run automatically during deployment or can be run manually:

```bash
npm run db:migrate
```

## Current Schema Tables

The following tables are defined in the schema:

- `users` - User accounts (id, username, password)
- `video_projects` - Video project data with processing state
- `cached_assets` - Cached analysis and media data
- `project_autosaves` - Auto-saved review data
- `edit_feedback` - User feedback on AI edit decisions
- `project_chat_messages` - Persisted companion chat messages
- `session` - PostgreSQL session store (created by connect-pg-simple)

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (required)

## Migration History

Migrations are tracked in the `drizzle` folder and applied in order.
Each migration file contains SQL statements for schema changes.
