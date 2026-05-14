# Fonts

The site self-hosts libre fonts from Google Fonts under SIL Open Font License
or an equivalent libre license. They are referenced from
`src/lib/styles/tokens.css`; no site page loads a third-party font CDN.

- `Source Serif 4`: body, headings, wordmark
- `Atkinson Hyperlegible`: navigation, labels, small caps
- `Martian Mono`: code, specimens, command examples

If the type direction changes, replace these files and update the `@font-face`
rules in `tokens.css`.
