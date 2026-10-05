# Usage rules
- Use edit for precise modifications; edits[].oldText must match exactly.
- When changing multiple nonadjacent locations in one file, pass multiple edits[] entries in one edit call instead of making repeated calls.
- Each edits[].oldText matches against the original file, not the result of sequential edits. Do not use overlapping or nested edits; combine adjacent changes into one edit.
- Keep edits[].oldText as short as possible while retaining uniqueness. Do not include large amounts of unchanged context.
