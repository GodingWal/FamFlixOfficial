# FamFlixW - Replit Environment Setup

## Project Overview
FamFlixW is a full-stack video creation and voice cloning application built with:
- **Frontend**: React + Vite + TypeScript
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit built-in)
- **ORM**: Drizzle ORM

## Architecture
- **Monorepo Structure**: Client and server code in single repository
- **Integrated Server**: Backend serves frontend via Vite dev middleware in development
- **Port**: Application runs on port 5000 (both frontend and backend)
- **Database**: PostgreSQL with 17 tables including users, videos, stories, voice profiles, etc.

## Environment Configuration

### Required Environment Variables (Set in Replit Secrets)
- `DATABASE_URL`: PostgreSQL connection string (auto-configured by Replit)
- `JWT_SECRET`: JWT token secret (min 32 chars)
- `JWT_REFRESH_SECRET`: JWT refresh token secret (min 32 chars)
- `SESSION_SECRET`: Session cookie secret (min 32 chars)

### Optional Features
- **Story Mode** (`FEATURE_STORY_MODE=true`): Requires Redis and S3 configuration
- **Stripe Billing**: Requires `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- **OpenAI**: Requires `OPENAI_API_KEY`
- **Email**: Requires SMTP configuration

## Database Setup
The PostgreSQL database includes:
- 16 core tables (users, videos, stories, voice_profiles, etc.)
- 1 template_videos table (created dynamically on first run)
- 4 enum types (story_category, story_rights_status, story_job_status, tts_provider)

### Database Schema Management
- Uses Drizzle ORM with dual support for SQLite (dev) and PostgreSQL (production)
- Migration files in `server/db/migrations/`
- Schema defined in `shared/schema.ts` (PostgreSQL) and `shared/schema-sqlite.ts` (SQLite)

## Development Workflow

### Running the App
```bash
npm run dev
```
This starts the integrated server on port 5000 with:
- Express backend API
- Vite dev server for React frontend
- Hot module replacement (HMR)

### Database Operations
```bash
npm run db:push       # Push schema changes to database
npm run db:generate   # Generate migration files
npm run db:migrate    # Run migrations
```

## Deployment Configuration
- **Type**: Autoscale (stateless)
- **Build**: `npm run build`
- **Run**: `npm start`
- **Port**: 5000

## Important Notes

### Proxy Configuration
The Vite dev server is configured with `allowedHosts: true` in `server/vite.ts` to work with Replit's proxy system. The application is accessed through Replit's webview iframe.

### Database Support
The application supports both SQLite (file-based) and PostgreSQL. The database type is detected automatically based on the `DATABASE_URL` format:
- SQLite: `file:./famflix.db`
- PostgreSQL: `postgresql://...`

### Known Warnings
- **Redis Connection Errors**: Expected when `FEATURE_STORY_MODE=true` but Redis is not configured
- **GPU/Ollama Warnings**: Expected in cloud environment, app falls back to simulation mode
- **Stripe Warnings**: Expected when Stripe keys are not configured

## File Structure
```
.
├── client/          # React frontend
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   └── lib/
│   └── index.html
├── server/          # Express backend
│   ├── db/          # Database migrations and schema
│   ├── routes/      # API routes
│   ├── services/    # Business logic
│   └── middleware/  # Auth, security, rate limiting
├── shared/          # Shared types and schemas
└── scripts/         # Utility scripts
```

## Recent Changes (Replit Setup)
- **2024-11-29**: Initial Replit environment setup
  - Configured PostgreSQL database with all required tables
  - Fixed `server/utils/templateVideos.ts` to support PostgreSQL (added `db.execute()` for PG)
  - Updated `vite.config.ts` to bind to 0.0.0.0:5000
  - Configured deployment as autoscale
  - Set up development workflow on port 5000
