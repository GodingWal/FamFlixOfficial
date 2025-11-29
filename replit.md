# FamFlixW - Replit Environment Setup

## Project Overview
FamFlixW is a full-stack video creation and voice cloning application built with:
- **Frontend**: React + Vite + TypeScript
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL (Replit built-in)
- **ORM**: Drizzle ORM
- **Voice Cloning**: F5/RVC providers (AI-powered)

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
- **Story Mode** (`FEATURE_STORY_MODE=true`): Works without Redis using synchronous ElevenLabs synthesis. Redis+S3 only needed for background job processing.
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

### PostgreSQL Compatibility
The codebase includes helper functions for database operations that work with both SQLite and PostgreSQL:
- `dbQuery()` - Returns array of rows (replaces db.all for SQLite)
- `dbQueryOne()` - Returns single row (replaces db.get for SQLite)
- `dbRun()` - Executes statement (replaces db.run for SQLite)

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

### Voice Cloning Providers
The application supports multiple TTS providers:
- **ElevenLabs** (Default): Real AI voice cloning via ElevenLabs API - requires `ELEVENLABS_API_KEY`
- **F5**: Local provider for speech synthesis (requires GPU server)
- **RVC**: Used for singing/vocal cloning (requires GPU server)
- Provider can be configured via the `TTS_PROVIDER` env var

### Known Warnings
- **GPU/Ollama Warnings**: Expected in cloud environment, app falls back to simulation mode
- **Stripe Warnings**: Expected when Stripe keys are not configured
- **Redis Warnings**: Only shown when FEATURE_STORY_MODE is enabled without Redis

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
│   ├── queues/      # Background job queues (Redis-based)
│   ├── workers/     # Background workers
│   └── middleware/  # Auth, security, rate limiting
├── shared/          # Shared types and schemas
└── scripts/         # Utility scripts
```

## Recent Changes

### 2025-11-29: Transcript Editing
- Added PATCH `/api/template-videos/:id/transcript` endpoint for admin editing
- Robust validation: non-empty segments, finite numbers, min 0.05s duration, no overlaps, non-empty text
- Edits preserve segment timing (start/end) for voice cloning synchronization
- Persists `transcriptSource: 'admin_edited'`, `editedAt`, `editedBy` metadata
- Sets `pipelineStatus: 'needs_regeneration'` to flag videos for re-processing
- Admin UI shows "Edit" button, editable text areas per segment, Save/Cancel
- Warning banner when transcript needs regeneration

### 2025-11-29: Segment-by-Segment Audio Sync
- Implemented proper audio synchronization using segment-by-segment ElevenLabs synthesis
- Each transcript segment is synthesized individually, then time-stretched to match original timing
- Added `timeStretchAudio()` function using ffmpeg's atempo filter (handles ratios outside 0.5-2.0)
- Added `generateSilence()` and `concatenateAudioFiles()` helpers for audio processing
- Gaps between segments are preserved with silence
- Fallback to full-text synthesis if no segments available

### 2025-11-29: Admin Transcript Viewer
- Added transcript viewer in Admin Video Catalog (`/admin/videos`)
- Shows Gemini AI transcription with timestamps
- Timeline view shows each segment with start/end timestamps
- Full text view shows complete transcript
- Displays metadata: source (Gemini AI or Edited), duration, segment count, timestamps
- GET endpoint: `GET /api/template-videos/:id/transcript` returns transcript with segments
- POST endpoint generates new transcript, PATCH endpoint saves edits

### 2025-11-29: Advertising Code Removal
- Completely removed AdBanner component and all ad-related code
- Removed `/api/ads/preferences` endpoints and schemas from backend
- Cleaned up Dashboard, VideoLibrary, Stories, and VideoSelectionCatalog pages
- Created test story "The Magical Forest Adventure" with 4 sections for testing

### 2025-11-29: Audio Content-Type Fix
- Fixed "Preview playback failed" error that appeared even when audio played successfully
- Audio endpoint now detects file extension and sets correct Content-Type header
- MP3 files from ElevenLabs now served with `audio/mpeg` instead of `audio/wav`

### 2025-11-29: ElevenLabs Voice Cloning Integration
- Added real AI voice cloning via ElevenLabs Instant Voice Cloning (IVC) API
- Created ElevenLabsProvider (`server/tts/providers/elevenlabs.ts`) for:
  - Creating voice clones from audio samples
  - Text-to-speech synthesis with cloned voices
  - Voice management (list, delete)
- Updated voice preview in `server/routes-simple.ts` to auto-migrate F5 profiles to ElevenLabs
- Added migration endpoint: `POST /api/voice-profiles/:id/migrate-to-elevenlabs`
- Voice preview now uses real ElevenLabs TTS instead of simulation
- **Note**: Requires valid `ELEVENLABS_API_KEY` secret to be set

### 2025-11-29: Voice Cloning Fixes
- Installed ffmpeg system dependency for audio format conversion (WebM to WAV)
- Added missing `provider` column to voice_profiles table
- Updated F5Provider with simulation mode for development without GPU server:
  - `server/tts/providers/f5.ts` - Falls back gracefully when GPU server unavailable
  - Uses voice sample as preview in simulation mode
- Voice cloning workflow now works end-to-end in Replit environment

### 2025-11-29: Video Processing Pipeline with Gemini + ElevenLabs
- Added Gemini AI integration for video transcription (`server/services/transcriptionService.ts`)
  - Extracts audio from video using ffmpeg
  - Uses Gemini 2.5 Flash to transcribe audio to text
  - Supports chunking for large files (>8MB limit)
  - Built-in rate limiting and retries
- Updated video processing pipeline to use real AI services:
  - First transcribes the video using Gemini AI if no existing transcript
  - Then uses ElevenLabs to synthesize speech with the cloned voice
  - Finally replaces the original audio with the new synthesized audio using ffmpeg
- Processing stages: starting → transcribing → transcript_ready → tts_synthesis → completed
- Uses Replit AI Integrations (billed to credits, no separate API key needed for Gemini)

### 2025-11-29: Replit Environment Setup Complete
- Configured PostgreSQL database with all required tables and enums
- Fixed SQLite-to-PostgreSQL compatibility in route handlers:
  - `server/routes/templateVideos.ts` - Added dbQuery/dbQueryOne/dbRun helpers
  - `server/routes/admin.ts` - Added dbQuery/dbQueryOne/dbRun helpers
  - `server/utils/templateVideos.ts` - Added db.execute() for PostgreSQL
- Made Redis connections conditional (only when FEATURE_STORY_MODE enabled):
  - `server/queues/connection.ts` - Lazy Redis connection
  - `server/queues/storyQueue.ts` - Null-safe queue creation
  - `server/workers/storyWorker.ts` - Null-safe worker creation
- Updated default TTS provider from CHATTERBOX to F5 in schema files
- Configured Vite with `allowedHosts: true` for Replit proxy
- Set up development workflow on port 5000
- Configured deployment as autoscale
