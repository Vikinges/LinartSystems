## PDF forms generator · service2

### v0.37
- Employee add dialog now asks for name and role with suggestions; new rows are prefilled.
- Multi-day add clones full day set for a new employee (name/role preserved).
- Unique employee counting in UI and PDF (avoids double counting days).
- Optional break calculation toggle; PDF hides break lines when disabled.
- Files archive: date filter uses calendar input; admin delete/zip works with service admin token.
- UI shows current version; /api/status returns version.

### v0.33
- Added project cards storage keyed by LSC Project number with autofill in Site information.
- Merged company/customer/person suggestion buckets to reduce duplicates.
- Employee name suggestions now stay populated across all rows.
- Minor UI copy: English header text, version bump.
- PDF layout: added breathing room for Service summary blocks to avoid overlap at page edges.
- PDF filenames now use LSC Project number + End customer + Employee #1 + service date (dd-mm-yy).

### v0.32
- Signature overlay: rotate/landscape controls, anti-squash scaling, mobile scale controls.
- Service report layout tweaks (parts table, mobile scaling).
