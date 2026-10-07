# Android Password Content Blocks

This document defines the browser extension's support for the password content blocks introduced by the Monica Android 1.0.315 line. A content block carries an API Key, API token, SSH key, GPG key or QR code inside an ordinary password record, without adding a Room table or a native MDBX type.

## Authority

- Repository: `Monica-Pass/Monica`
- Writer/reader: `Monica for Android/app/src/main/java/takagi/ru/monica/data/model/PasswordContentBlocks.kt`
- QR templates: `PasswordQrTemplate.kt` and `docs/QR-FIELD-TEMPLATES-1.0.315.zh-CN.md`
- Format contract: `Monica for Android/docs/PASSWORD-CONTENT-BLOCKS-1.0.315.zh-CN.md`
- Extension codec: `src/core/password-content-blocks.ts`

The extension treats the transport as Android-owned data. It reads and writes the same fields the Android codec validates, and it never invents a second representation.

## Transport

| Part | Shape |
| --- | --- |
| Manifest | `monica.content.block.<uuid>` = `{"version":1,"encoding":"base64","parts":N,"sha256":"<hex>"}` |
| Chunks | `monica.content.block.<uuid>.0000` upward, Base64, at most 1600 characters each |
| Content | The Base64 of the UTF-8 JSON `{"version":1,"id":"<uuid>","kind":"API_KEY\|API_TOKEN\|SSH_KEY\|GPG_KEY\|QR_CODE","title":…,"data":{…}}` |
| Order | `monica.content.order`, comma separated, marks block positions with `BLOCK:<uuid>` |
| Protection | Every manifest and chunk field is written with `is_protected=true` |
| Limit | One block holds at most 256 KiB and at most 220 parts |

A block is only readable when the manifest is unique, the version and encoding match, the declared part count matches the chunks, every chunk is within the size limit, the SHA-256 of the decoded bytes matches, the JSON decodes as UTF-8, and the envelope version, id, kind, title and kind-specific field shapes are valid.

## Browser status: Full

| Capability | Status | Notes |
| --- | --- | --- |
| Read blocks | Full | The item detail shows each block as its own section with the Android field labels and order |
| Edit blocks | Full | The login editor can add, edit, delete and reorder all five kinds |
| Secrets | Full | Keys, tokens, private keys and QR text stay hidden until an explicit reveal or copy |
| QR codes | Full | A QR preview is generated only after an explicit click; field templates expand from the current item values |
| Damaged blocks | Preserved | Missing, duplicated, truncated, mismatched, unknown-version and unknown-kind blocks stay visible as read-only and keep every raw field byte-identical |
| Transport fields | Preserved | The manifest, the chunks and the order field are hidden in the manager UI, survive edits unchanged, and are never sent to a web page |

Behavior that matches the Android implementation:

- Field labels, secret fields and editable keys follow `PasswordContentBlocks.editableKeys` and the Android `secretField` list.
- `monica.content.order` keeps existing section tokens and only appends or drops `BLOCK:` tokens.
- Writing a block replaces its manifest and every chunk, keeps unknown keys of the previous manifest, and leaves other custom fields untouched.
- Deleting a block requires a readable block, so a damaged block is never replaced by an empty form.
- QR field templates support `%%`, `%ACCOUNT%`, `%PASSWORD%`, `%TITLE%`, `%URL%`, `%EMAIL%`, `%PHONE%`, `%NOTES%` and `%FIELD:<base64url name>%`, with Wi-Fi escaping and the same failure semantics.
- Autofill sends only ordinary custom fields to a page, because a chunk carries the Base64 of a secret.

## Provider coverage

The transport uses protected custom fields, so every provider path carries it without a new codec: MDBX2 (`custom_fields`), Android WebDAV backups (`isProtected`), Bitwarden ciphers (hidden field type) and KeePass protected fields. The save prompt that updates an existing login keeps the block fields, because it only replaces the username and the password.

## Acceptance evidence

- `src/core/password-content-blocks.test.ts`: transport decode, write-back with unknown keys, chunking and the size limit, the damage matrix, ordering, removal, and QR template rendering.
- `src/core/sha256.test.ts`: digest parity with the platform implementation, because block validation depends on it.
- `tests/e2e/content-blocks.spec.ts`: a hand-built Android transport renders readably; an edit round trip is re-validated with an independent SHA-256; QR templates render a real QR image; a damaged block stays read-only; the section stays usable at 320 px and 200% text.
