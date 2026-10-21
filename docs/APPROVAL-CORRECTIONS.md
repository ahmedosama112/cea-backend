# Approval corrections (phase 1)

The API keeps the existing submission/revision/review chain as the approval authority. Google synchronization is a later operation, not a condition for resolving a correction. There are no scheduled reminders, new external messages, or changes to Google signatures in this feature.

## Existing workflow and data decisions

- `POST /submissions` starts the existing project-specific approval chain. `POST /submissions/:id/resend` archives the prior file and increments the same submission's revision. Both remain in use. A directly necessary change at the Google synchronization boundary associates requests/results with their revision, skips obsolete queued uploads, and stores late results on the archived revision; stale background accounting also checks the revision under lock. This preserves existing Google API/signature behavior while preventing a new resend from inheriting an old job’s result. Future resends archive the old Google row/Drive reference in SubmissionRevision before clearing the current version links; historical missing references are not invented.
- `POST /approvals/:id/decide` and `/rows/reject` retain assigned-approver rules, explicit viewer restrictions and approval windows. Legacy admin `/submissions/:id/review` rejection now creates the same obligation and returns the submission for resend.
- `CorrectionTask` describes an obligation, using `(sourceId, sourceRevision, sheetIndex, row)`. A whole rejection uses sheet -1 / row 0. It does not introduce an alternative approval decision.
- `CorrectionLink` records each actual replacement and its explicit target coordinates. A nullable unique `active_task_id` reserves one active replacement per task on MySQL (no partial indexes required).
- `CorrectionDraft` stores task IDs and edits, not arbitrary client files or payable totals. Draft creation, reads, saves and deletion do not mark a task resent. Only the submission transaction reserves tasks, creates a replacement/file, and marks them RESENT.
- `SubmissionRowRejection` retains immutable classification actor/time/reason (including FINAL, independently of deletable discussion comments). `CorrectionEvent` records requests, classification, replacements, repeated strikes, rejection and resolution. The task shows the latest rejection reason/actor while events preserve the history. Age remains the age of the original obligation.
- OPEN → RESENT occurs on successful submission. Rejection returns the original tasks to OPEN and releases their reservations. Final chain approval resolves accepted rows only; re-struck rows reopen the same tasks. A whole rejection remains RESENT while its replacement has outstanding correctable parts, then resolves after those parts are approved.
- Full rejection supersedes its partial tasks in the OPEN list and summary; it does not delete them. Resending binds them to the new revision. Queue hiding, notification dismissal and the queue's seven-day filter never close or hide open obligations.
- A FINAL strike creates no correction obligation. Existing strikes have NULL disposition and retain their financial effect. Assigned approvers/admins can classify a legacy strike of the current revision once, with a reason; no implicit reopening or reclassification of FINAL/processed rows is supported. A replacement of an existing correction cannot abandon the obligation by selecting FINAL; it must remain tracked until approved.

## Source files, financial data and permissions

Drafts use one source submission and revision, preserving its engineer, project, site, type and period even when the engineer's account changes. Source files and prior revisions are never rewritten. Only selected rejected days enter a correction workbook; all other rows are cleared and unused sheets removed. The explicit sheet mapping is recorded before removal. Embedded images/old signature annotations are removed; current revision approvals are stamped through the existing signing service.

Labor quantity/price edits use Decimal and recompute row and sheet totals on the server. Equipment uses the actual H:I merged time range, J:K place and G duration layout; its result remains operating hours, not money. As in the existing row editor, combined labor records and combined equipment time ranges support notes but do not guess missing financial detail; the UI explains when manager review is needed. Missing or unreadable source versions produce an explicit error instead of an incomplete file.

Whole resends map outstanding days using contractor, place and date from their archived source version, never the bare row number. Ambiguous/missing matches are conflicts; archived FINAL dates cannot be reintroduced. Fully FINAL submissions cannot be resent. Submission/revision state changes, row edits, strikes and correction submissions serialize using source row locks and conditional updates. Slow Excel/storage preparation is outside transactions, and last-level approval checks updatedAt to reject concurrent stale edits.

Before sending a correction against a legacy approved original with no accounting cache, the source accepted amount/days are reconstructed from its actual current file/decisions and committed with the replacement; the gross original total cannot be paid alongside the replacement. Merely classifying a strike does not change its financial effect. The accepted labor amount and labor-day details are prepared outside the transaction and committed together with final approval. Thus a report cannot briefly count a partially rejected correction at its original gross value while Google is pending. `total` retains its submission meaning; `approvedTotal` carries the accepted amount. Reports require SENT plus the existing current-revision PM decision. Labor dates use date column M with the old column-L fallback, so original excluded days plus approved replacement days can be checked for duplicates.

No existing Record-to-Submission/day link exists in the old schema. Contractor-name similarity cannot prove that an old unlinked replacement was paid. Migrated/legacy-classified tasks show a manual-review warning; no automatic match, close, or payment block is inferred. There is no user-submitted owner/project/site/total override on correction submission.

The engineer endpoints require the submissions module and enforce ownership on every task/draft ID. Manager lists use the existing approvals module's global metadata visibility. Decisions/classification still require the assigned actor; seeing the list grants no approval authority. Lists are paginated and bounded, have no file/image fetches or per-row queries, and can filter engineer/project/state/age. Source/linked submissions and accounts with correction history cannot be deleted, including after resolution; clear conflict messages protect the audit trail. Account deletion and submission deletion check history under locks before removing source files. Actors are stored by ID even if a reviewer account later disappears.

## API additions

Engineer base: `/api/submissions/corrections`.

- `GET /?state=OPEN|RESENT|RESOLVED&page=1&limit=30` returns a page and separate open submission/day summary.
- `GET /drafts`, `POST /drafts {taskIds:[string]}`.
- `GET /drafts/:id`, `PATCH /drafts/:id {version, edits:[{taskId,qty?,price?,notes?,timeFrom?,timeTo?}]}`, `DELETE /drafts/:id`.
- `GET /drafts/:id/file` builds an authenticated preview.
- `POST /drafts/:id/submit {version}` applies the normal submission window/chain. Retrying a committed draft returns its existing replacement. Competing submits conflict or return that same replacement; neither creates another claim.

Google retry (`gsync`) requires the current version to be SENT; it cannot bypass outstanding approvals.

Manager: `GET /api/approvals/corrections` with the same state/page/limit plus `ownerId`, `ownerSearch` (name/email), `projectId`, `minAgeHours`, `staleHours` (default 48).

`POST /api/approvals/:id/rows/reject` now requires `disposition: CORRECTION|FINAL` as well as the existing reason. `POST /api/approvals/:id/rows/classify` takes `{revision,sheetIndex,row,disposition,note}` for an unclassified legacy strike. Existing resend uses its existing multipart contract, while committing the revision, chain reset and correction links atomically. A lost resend response never increments a revision twice through concurrent updates.

## Migration, rollout and recovery

1. Back up the DB and upload files. Include the four correction tables in both backup and restore; restoration order is source submissions → tasks → links/drafts → events. Test on a disposable copy first. No production DB was used during development.
2. Apply `20261021120000_approval_corrections`, generate Prisma, and build the backend. Tables/nullable disposition are additive. Legacy admin REJECTED state is reconciled only when its reviewedAt is at least the current submittedAt; stale status from an older resend must not return a newer in-review revision.
3. The migration backfills whole requests from actual RETURNED submissions with their existing current-revision rejection metadata. Its backfill/event statements can be rerun without duplicates; do not rerun the CREATE TABLE section. It does not turn old strikes into correction tasks or rewrite their files/reviews/Google links.
4. Deploy this backend, then the paired frontend promptly and have managers refresh. The required disposition cannot be inferred for an old cached frontend; such clients receive 400 on row strikes until refreshed. Other submission/approval paths remain available. Publish `corrections.js` with the PWA shell and network-first code list.
5. Smoke-test engineer/manager workflows on test accounts, including a partial correction, whole resend, stale/hidden rejection, repeated strike, concurrent submit and Google failure. Compare task counts, original/replacement accepted sums and contractor days before/after.

Rollback: stop new corrections and retain all four tables, source files, replacement files and audit rows. Prefer reverting the UI first and keeping this backend available for in-flight corrections. Do not deploy a pre-feature backend while linked corrections are still being processed: it would miss obligation transitions. A full rollback requires draining/mapping in-flight tasks and a separately reviewed recovery operation. Do not drop correction tables, reset IDs or revert a DB snapshot over newer submissions. The feature was not deployed to production.

## Validation

Backend: `npm run build`, `npm test` (through the cea_test safety wrapper). Correction tests include simultaneous requests, transaction failure after writes, legacy classification, moved Excel rows, full/partial overlap, FINAL exclusions, source failures, equipment, permission checks, report totals/days and failed Google synchronization.

A separate legacy-schema MySQL database was used to execute the SQL migration and rerun just the backfill, verifying retained submission counts, one task per returned version, unchanged unclassified strikes, and one audit event per backfilled task. The paired frontend was exercised in Chromium against the real local API with separate engineer/manager accounts; no production access or deployment was performed.

Final local result: `npm run build` passed; `npm test` executed 295 passing tests in 24 files (26 dedicated correction cases). Frontend: 13 passing tests, PWA build and real mobile Chromium workflow. Migration/backfill verification retained four representative old submissions, created only the two actual rejection requests, left old strikes unclassified, and preserved a newer revision with stale old status. No production changes or publication were performed.
