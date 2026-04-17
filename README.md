# SHM Ingestion Backend (FTP -> MongoDB)

This backend now includes a production-oriented SHM ingestion pipeline that:

1. Reads active projects with FTP config from MongoDB
2. Downloads only new files from FTP every 10 minutes (worker)
3. Parses Excel and MiniSEED data
4. Stores normalized points in MongoDB (`Data` collection)
5. Exposes APIs for projects and latest data

## Runtime Roles

- Web API (Render Web Service): `node server.js`
- Worker (Render Background Worker): `node cron.js`

## Required Environment Variables

- `MONGO_URI` - MongoDB connection string
- `JWT_SECRET` - JWT secret for protected APIs
- `PORT` - API port (default 5000)
- `NODE_ENV` - `development` or `production`
- `CLIENT_URL` - frontend origins (comma-separated in production)
- `SHM_FTP_TIMEOUT_MS` - optional FTP timeout (default `20000`)
- `SHM_MAX_PROCESSED_FILES` - optional processed file history cap (default `5000`)
- `SHM_INSERT_BATCH_SIZE` - optional DB insert batch size (default `2000`)
- `CRON_TZ` - optional cron timezone (default `UTC`)
- `EVENT_TRIGGER_BACKUP_ENABLED` - keep backup trigger loop disabled for single-path mode (default `false`)
- `EVENT_TRIGGER_BACKUP_MAX_FILES_PER_PROJECT` - backup scan depth when enabled (default `1`)

## APIs

- `GET /api/projects` (existing project API; now carries FTP/type/activity fields too)
- `GET /api/data?projectId=<id>` -> latest 100 records by timestamp desc
- `GET /api/ingestion/projects` -> focused ingestion project view
- `POST /api/ingestion/projects` -> create FTP ingestion project (admin)

## Install and Run

```bash
cd backend
npm install
npm run start
```

Worker:

```bash
cd backend
npm run worker
```

Run one ingestion cycle manually:

```bash
cd backend
npm run worker:once
```

## Notes

- Duplicate prevention is done using both:
  - per-project `processedFiles` tracking
  - unique index on `Data` (`projectId + sourceFile + sourceIndex`)
- Downloaded files are deleted after parsing to prevent disk growth.
- Per-project failures do not stop other projects from processing.
