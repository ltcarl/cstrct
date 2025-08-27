# cstrct — Architecture

> Construction plan management (Procore-like), optimized for mechanical/HVAC/plumbing to start, expandable to general construction.

## Stack

- **Frontend/Server**: Next.js (App Router, TypeScript), Node runtime
- **Package manager**: pnpm
- **Auth**: `auth()` (NextAuth-style) — `session.user.id` available server-side
- **DB**: PostgreSQL + Prisma ORM
- **Object storage**: MinIO (S3-compatible) locally; AWS S3 later (drop-in)
- **OCR**: Poppler (`pdftotext`, `pdftoppm`, `pdfinfo`), Tesseract, Sharp
- **CI/Deploy**: local Ubuntu box (git pull + pnpm build/start)

## Directory Layout
src/
app/
api/
files/
sign-get/route.ts
plans/
[planId]/
route.ts # GET plan (minimal) for review page
ocr/route.ts # POST – run OCR (vector-first, OCR fallback)
apply-suggestions/route.ts # POST – accept OCR suggestions
projects/
[projectId]/
plans/
route.ts # GET list, POST create PlanSheet
presign/route.ts # POST – presigned PUT for uploads
[projectId]/
ocr-settings/route.ts # GET/PATCH – regions & DPI
plans/
[id]/
review/page.tsx # Single-sheet review: drag boxes, Run OCR, Accept
projects/
[id]/page.tsx # Plans list + upload → redirect to review
components/
PlanViewer.tsx # (if used) PDF preview component
lib/
auth.ts # session
db.ts # Prisma client
prisma/
schema.prisma
migrations/

## Environment
Database

DATABASE_URL=postgresql://user:pass@localhost:5432/cstrct

Object storage

STORAGE_PROVIDER=minio
S3_BUCKET=cstrct
S3_PUBLIC_BASE_URL=http://<minio-host>:9000/cstrct
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin

NextAuth/etc as configured in /lib/auth.ts

NEXTAUTH_URL=...
NEXTAUTH_SECRET=...

> Local tools required on the Ubuntu host: `tesseract`, `poppler-utils` (`pdftotext`, `pdftoppm`, `pdfinfo`), `sharp` deps (`libvips` packaged via sharp).

## Data Model (Prisma)

Key parts (omitting non-essential fields):

```prisma
model User {
  id             String       @id @default(cuid())
  // ...
  uploadedPlans  PlanSheet[]  @relation("UserUploadedPlans")
}

model Project {
  id               String   @id @default(cuid())
  name             String
  // OCR defaults (percent-based regions of page)
  ocrDpi           Int?     // default DPI when rasterizing
  ocrNumberRegion  Json?    // {xPct,yPct,wPct,hPct}
  ocrTitleRegion   Json?
  // ...
}

enum OcrStatus { PENDING RUNNING DONE FAILED }

enum Discipline { ARCH CIVIL DEMO ELEC FP HVAC PLUMB STRUC TELE OTHER }

model PlanSheet {
  id              String     @id @default(cuid())
  projectId       String
  project         Project    @relation(fields: [projectId], references: [id])

  uploaderId      String?    // optional for legacy rows; set for new rows
  uploader        User?      @relation("UserUploadedPlans", fields: [uploaderId], references: [id])

  sheetNumber     String?
  title           String?
  discipline      Discipline?
  version         Int        @default(1)

  fileKey         String
  fileUrl         String?
  ocrStatus       OcrStatus  @default(PENDING)

  ocrSuggestedNumber String?
  ocrSuggestedTitle  String?
  ocrSuggestedDisc   Discipline?
  ocrConfidence      Float?
  ocrRaw             Json?

  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt @default(now())
}

Migration notes

If adding uploaderId/updatedAt to existing tables: add them optional first with defaults, migrate, optionally backfill, then tighten to required if desired.

Storage Flow

Client calls POST /api/projects/:projectId/plans/presign → returns { uploadUrl, key, publicUrl? }.

Client PUTs the PDF to uploadUrl.

Client calls POST /api/projects/:projectId/plans with { fileKey, fileUrl? }.

Server creates PlanSheet with ocrStatus=PENDING.

Client redirects to /plans/:planId/review.

Sign GET: /api/files/sign-get returns a short-lived URL for opening the PDF in a new tab (works for MinIO and S3).

OCR Pipeline (Server)

Order of operations in POST /api/plans/:planId/ocr:

Download PDF from storage to tmp.

Vector-first extraction: rotation-aware pdftotextRegion() for Number and Title boxes (region is % of page).

Uses pdfinfo rotation (0/90/180/270), remaps crop, then pdftotext -x/-y/-W/-H.

If a field is missing/weak: Rasterize page → PNG via pdftoppm -r {dpi}.

Number OCR: crop region, trim borders, test PSM 7 variants (thresholds 190/170 + no-threshold), pick via pickSheetNumber. Apply O↔0 fix.

Title OCR: crop region, try rotations 0/90/270 using PSM 6, pick best via simple scoring, join top two lines.

Fallback signals:

pdftotext -layout full page (embedded text)

Full-page Tesseract PSM 6 only if both fields missing and embedded weak

Suggest: choose final sheetNumber/title/discipline, compute ocrConfidence, save ocrRaw debug, set ocrStatus=DONE.

Returns:
{
  "ok": true,
  "suggestions": { "sheetNumber": "...", "title": "...", "discipline": "HVAC", "confidence": 0.82 },
  "debug": {
    "numberOCR": { "variants": [/* tried crops */] },
    "usedNumberRegionText": true,
    "usedTitleRegionText": false,
    "lengths": { "numRegion": 5, "titleRegion": 28 }
  }
}

Pages / UX

/projects/:id — Plan list + single-file upload.
On success, redirect to per-sheet review.

/plans/:id/review — Review a sheet:

shows first-page preview PNG,

two draggable boxes (Number: blue, Title: amber),

Run OCR button: PATCH project OCR regions → POST run OCR,

shows suggestions + up to 5 alt sheet numbers,

Accept applies suggestions to PlanSheet and (by default) keeps these regions as project defaults.

API Contracts (summary)

POST /api/projects/:id/plans/presign → { uploadUrl, key, publicUrl? }

GET /api/projects/:id/plans → PlanSheet[] (min fields for table)

POST /api/projects/:id/plans → { id, projectId }

GET /api/projects/:id/ocr-settings → { ocrDpi?, ocrNumberRegion?, ocrTitleRegion? }

PATCH /api/projects/:id/ocr-settings → upserts project OCR defaults

GET /api/plans/:planId → { id, projectId }

POST /api/plans/:planId/ocr → { ok, suggestions, debug }

POST /api/plans/:planId/apply-suggestions → apply OCR suggestions and optionally persist regions

Conventions

Regions: stored as %s of page size { xPct, yPct, wPct, hPct } (works for different page sizes).

DPI: project-level ocrDpi default; typical 300.

Numbers: treat as codes → PSM 7, whitelist alphanumerics + .-, fix common O↔0.

Titles: prefer pdftotextRegion, compare against rotated OCR, keep best.

# Pull code
git pull

# Install
pnpm install
pnpm approve-builds    # approve prisma scripts (if prompted)

# Prisma
pnpm prisma migrate deploy   # or migrate dev if iterating
pnpm prisma generate

# Run
pnpm build
pnpm start

Troubleshooting

Prisma add required columns fails on migrate
→ Add columns optional + @default(now()), migrate, backfill, then tighten.

“Unknown file extension .ts for prisma/seed.ts”
→ Use JS seed: "prisma": { "seed": "node prisma/seed.js" }.

MinIO signed GET 403
→ Check bucket policy or always go through /api/files/sign-get (server-signed URL).

OCR misses last digit (e.g., 68H01 → 68H0)
→ Ensure border-trim + upscaling; keep PSM 7; apply O↔0 fix.

Region correct but pdftotext wrong area
→ Ensure rotation-aware region mapping (this repo uses it).

Roadmap (near-term)

✅ One-button Run OCR (saves regions + runs OCR)

✅ Accept suggestions; reuse regions for project

☐ Batch uploads: after Accept, auto-open next pending plan

☐ Plan versioning rules (supersede by sheet number)

☐ RFI/Submittals/CO modules (data model + basic flows)

☐ Authz/roles per project (viewer/editor/admin)

☐ S3 (AWS) switch via env only (validate with presign + sign-get)