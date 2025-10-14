# PDF Preventative Maintenance Service – Project Guide

## 1. Overview
- Node.js 20 + Express application that serves a maintenance checklist form and produces a filled PDF plus JSON metadata.
- PDF generation relies on pdf-lib and an AcroForm template stored at public/form-template.pdf.
- Field definitions come from ields.json; human-friendly labels can be overridden via mapping.json.
- The service can be containerised via the provided Dockerfile/docker-compose.

## 2. Repository Map
- server.js – Express server, dynamic HTML generator (generateIndexHtml), /submit handler, PDF generation pipeline, suggestion store.
- generate-template.js – Offline script that can rebuild the HTML template based on ields.json.
- extract-fields.js – Extracts AcroForm field metadata from the template PDF into ields.json.
- public/index.html – Generated form that is rewritten every time the server starts.
- public/forms.html – Entry page that lets the user choose a form (currently one live template).
- data/store.json – Suggestion cache for auto-complete fields.
- out/ – Filled PDFs plus JSON sidecars.

## 3. Running Locally
### Prerequisites
- Node.js 20+
- npm
- Optional: Docker / Docker Compose

### Commands
`ash
npm install
node generate-template.js   # optional, only if template change needed
npm run extract-fields       # optional, keeps fields.json in sync with PDF
npm start
`

### Docker
`ash
docker compose up --build -d
# service available on http://<host>:3000/
`

## 4. API Surface
- GET / – Shows the template selector (public/forms.html).
- GET /form/:templateId – Serves a generated HTML form for the chosen template (currently maintenance).
- GET /templates – Returns catalogue of available templates (id, label, description, default).
- POST /submit – Accepts multipart form data, produces the filled PDF, and returns { ok, url, overflowCount, partsRowsHidden } with a download link.
- GET /download/:file – Streams the generated PDF.
- GET /suggest – Returns autocomplete suggestions for supported text fields.

## 5. Front-end Form Highlights
- Photos card contains three upload slots (photo_before, photo_after, photos[]).
- Parts table renders 15 rows; only the first is visible, additional rows can be toggled via + Add another part / – Remove last row (handled by setupPartsTable() in the generated script).
- Signature pads use <canvas> elements; drawings are captured as base64 PNG strings and submitted with the form.
- Debug toggle (in UI) can be added later; currently no debug flag is exposed on the form.

## 6. PDF Generation Flow
1. Validate template path and load the PDF with pdf-lib.
2. Apply field values:
   - Text fields shrink font size automatically when needed (layoutTextForField).
   - Checkbox/option fields map to form selections.
   - Text values that exceed the field height are captured as overflow entries.
3. Photos:
   - photo_before and photo_after are embedded on dedicated pages via embedLabeledPhotoPage.
   - Additional photos (photos[]) are processed by embedUploadedImages.
4. Signatures and summary:
   - drawSignOffPage creates a new PDF page that includes parts usage, sign-off checklist, engineer/customer details, and both signatures.
   - Signature data is taken from the base64 inputs; the original sign-off fields in the template are cleared.
5. Overflow text is appended to extra pages via ppendOverflowPages.
6. Metadata (JSON) records file locations, overflow entries, parts usage, and signature placements.

## 7. Suggestion Store
- Located at data/store.json.
- Updated after each successful submission for specific fields (customer/company/engineer names).
- /suggest endpoint serves values with a simple prefix filter once the user types = 3 characters.

## 8. Known Issues / TODO
- [ ] Alignment of the regenerated maintenance summary page still needs visual QA (verify layout in Acrobat/Preview).
- [x] Consider hiding the original template sign-off section if unnecessary. (Replaced with a generated summary page.)
- [ ] Add automated smoke script that posts the demo payload and checks resulting PDF metadata.
- [ ] Multi-template support: current catalogue contains only the preventative maintenance form.
- [ ] Add automated coverage for the new upload/debug helpers (front-end smoke + backend unit tests).

## 9. Multi-template Plan (future work)
- Maintain a 	emplates/catalog.json describing each form (id, label, description, file paths, default flag).
- Split per-template field/mapping files under 	emplates/<id>/.
- Extend /submit to expect 	emplate_id and route processing accordingly.
- Reuse suggestion store by namespace: 	emplateId:fieldName.
- Build additional HTML/PDF generators (Calibration Protocol, Wartungsprotokoll, Tätigkeitsbericht).

## 10. Onboarding Checklist for New Assistants
1. Review this guide to understand repo layout and build pipeline.
2. Inspect server.js, especially generateIndexHtml, drawSignOffPage, and /submit.
3. Start the server (
pm start or Docker) and open http://localhost:3000/ to test the form.
4. Submit the prefilled sample data, then inspect the generated PDF and JSON in out/.
5. When modifying the PDF or form structure, remember that generateIndexHtml overwrites public/index.html on start.
6. Update this document (PROJECT_GUIDE.md) whenever functionality shifts so future sessions ramp faster.

## 11. 2025-02-09 Restoration Notes
- Restored rich photo handling: `photo_before`, `photo_after`, `photos` now accept up to 20 images each, render thumbnails/previews, and expose a cumulative upload summary.
- Added submission UX: real-time progress bar via XHR, cursor feedback, and a persistent debug toggle (timeline written to the panel and preserved in localStorage).
- Migrated checklist notes to auto-growing textareas (front-end auto-resize + dynamic font sizing inside the PDF) so long text no longer disappears.
- Rebuilt the PDF pipeline: resized text fields with overflow capture, appended "Extended Text" pages when needed, redrew the parts table, and generated a clean maintenance summary/sign-off page (original template block is cleared).
- Image metadata now records the source form field, label, and placement page; JSON metadata captures overflow text, hidden parts rows, and signature placements.
- Auto-rotated photo pages: each uploaded image now claims its own portrait/landscape PDF page with captioned orientation.
- Parts table on the form starts with a single editable row and grows via +/− controls (max 15, matching PDF consumption).
- Front-end previews fall back to FileReader data URLs when object URLs fail, covering stricter browsers / Windows edge cases.

### Follow-up Checklist
- [ ] Run end-to-end submission with large sample data to confirm overflow pages and maintenance summary match expected branding.
- [ ] Add regression tests for `layoutTextForField` and the sign-off renderer.
- [ ] Validate that debug timeline captures enough detail for future triage; adjust events if gaps appear.
- [ ] Exercise the photo orientation logic with mixed portrait/landscape sources; verify captions and rotation match expectations.

## 12. Communication & Deployment Notes
- **Preferred communication language:** Russian. Keep commit messages and documentation in English unless a Russian summary is explicitly requested.
- **Source repository:** https://github.com/Vikinges/PDF_generator.git (`main` branch is the default deployment branch).
- **Local deployment:**
  1. `npm install`
  2. `npm run extract-fields` (optional—only if the template PDF changed)
  3. `npm start`
  4. Open http://localhost:3000/ in a browser.
- **Environment expectations:** Node.js 20+, npm 10+. The server binds to `PORT` (defaults to 3000) and respects `HOST_URL`/`TEMPLATE_PATH` from `.env`.
- **Publishing updates:** run `npm test` ( to be implemented ), `git commit`, then `git push` to `origin/main`. GitHub Actions are not configured yet; manual deployment is required.
- **Artifacts:** generated PDFs/JSON land in `out/`; ensure the directory is writable in the target environment.

