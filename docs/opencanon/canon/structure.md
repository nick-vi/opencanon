# Structure

## Folder Structure

Folders use responsibility names.

Avoid source folders named:

- `misc`
- `helpers`
- `common`
- `temp`
- `new`
- `draft`

Rules:

- Put files where their primary responsibility lives.
- Use folder-specific file suffixes when a convention exists, such as `src/services/*.service.ts`.
- Prefer existing folder vocabulary.
- Split files that mix responsibilities instead of naming around ambiguity.
