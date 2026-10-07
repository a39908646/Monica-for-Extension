# Monica MDBX2 Native Host

This process is the trusted MDBX2 runtime for Monica Extension. It uses the exact Monica MDBX2 core instead of reproducing format, cryptography, Commit2 or synchronization rules in TypeScript.

## Core pin

`mdbx-ffi` is fetched from `https://github.com/Monica-Pass/Mdbx.git` at revision:

```text
974c517465e7b6cac0947d2d59875aa4211fa16b
```

The Rust toolchain is pinned to `1.86.0` to match the MDBX2 release build.

## Current protocol

Host name: `com.monica_pass.mdbx2`

Protocol version 2 exposes the pinned capability handshake, durable file staging, MDBX2 vault access and Android-compatible incremental synchronization:

```text
host.hello
transfer.begin
transfer.chunk
transfer.finish
transfer.abort
vault.inspect
vault.open
vault.status
vault.lock
collection.list
object.list
object.reveal
object.upsert
object.delete
object.batch
object.operation.status
object.operation.resolve
history.list
history.diff
conflict.list
conflict.resolve
transfer.read
transfer.release
sync.state.register
sync.state.status
sync.bootstrap.prepare
sync.bootstrap.commit
sync.segment.prepare
sync.segment.commit
sync.stream.list
sync.stream.block
sync.segment.inspect
sync.segment.apply
sync.segment.acknowledge
sync.blob.list
sync.blob.read
sync.blob.remote.verify
sync.blob.receive.begin
sync.blob.receive.chunk
sync.blob.receive.abort
```

The handshake reports the Host version, exact core revision, MDBX2 format generation, build capability manifest, 256 KiB chunk limit, 2 GiB file limit, 50-item history/conflict page limits, 850 KiB history/conflict response limits and supported unlock methods. It explicitly reports `supportsMdbx1: false`.

Native Messaging messages are framed as four native-endian length bytes followed by UTF-8 JSON. Input control frames are limited to 1 MiB and Host output frames to 900 KiB. Binary transfers use at most 256 KiB of raw bytes per Base64 chunk.

Inbound transfer state uses two alternating durable metadata slots. Chunks require the exact durable offset; a byte-identical retry is idempotent. `transfer.finish` verifies declared size and SHA-256 before publishing an opaque file handle.

`vault.inspect` calls the core's read-only migration inspection and accepts exact `MDBX-2` only. `MDBX-1` and `MDBX-1-DRAFT` are rejected before `open_vault*` can invoke automatic migration. Older MDBX2 schemas receive a local portable backup before the pinned core upgrades the app-private working copy.

Collection and Object summaries are paged at no more than 200 records. Object disclosure is capped at 512 KiB and remains subject to the core Tiga policy. Writes use only the pinned core's typed `MdbxWriteCommand` operations and one idempotent operation UUID; no SQL surface is exported. Monica logical IDs are stored in `payload.monica_entry_id`, while physical IDs use the same `UUID.nameUUIDFromBytes` algorithm as Android.

Provider reconciliation groups up to 50 Object mutations into one bounded user-level operation instead of creating one Commit per item. Multi-item intent is capped at 384 KiB by the Native Messaging boundary; a larger single Object retains the existing 512 KiB payload limit. The Host generates a random operation UUID, stores only bounded local receipt hashes and Commit metadata in alternating durable slots, and can resolve a lost Service Worker response after restart without placing secret-derived deterministic IDs into the synchronized Commit DAG. Reusing one operation ID or operation scope with different semantic content fails closed.

Commit history is exposed read-only in pages of at most 50 records. Commit diffs use the core's 500-Object bound. The Host returns titles, deletion state, changed-field names and a `payloadChanged` boolean, but deliberately removes decrypted payload previews before crossing into the manager page. Oversized results fail before the 900 KiB Native Messaging frame boundary.

Vault health checks expose aggregate severity, allowlisted categories and semantic issue-kind enums only. The Host may inspect a Core description to classify pending verification, authentication failure, Tombstone variants or inactive devices, but the description itself and any embedded paths or identifiers never cross Native Messaging. Unknown/future checks collapse to one generic issue kind.

Unresolved conflicts are exposed in pages of at most 50 records. Summary responses omit base/local/incoming Commit IDs and payload previews. Resolution supports explicit local-wins or incoming-wins only. Random operation IDs are persisted in alternating bounded receipt files; reuse with another conflict or choice fails, completed retries are idempotent, and an incomplete receipt after the conflict disappears returns an unknown-outcome error instead of applying another winner.

Synchronization state uses two alternating durable slots. A portable `.mdbx` file initializes a device; normal multi-device operation exchanges authenticated bundle v8 segments, state deltas and encrypted external Blobs. Export checkpoints advance only after immutable publication, and remote stream cursors advance only after atomic apply and Blob completion.

The extension registers the MDBX2 provider only in the privileged background. Windows Hello uses the separate `com.monica_pass.windows_hello` Native Messaging registration; it shares the reviewed executable package but has an independent manifest, registry entry and extension client connection. Raw Collection, Object, history and conflict commands are accepted from `index.html` and rejected from Popup, content scripts and web pages. Locking the Monica vault, locking an MDBX2 source or removing the source clears the background compatibility cache.

## Build

```powershell
cargo test --manifest-path native/mdbx2-host/Cargo.toml
cargo build --release --manifest-path native/mdbx2-host/Cargo.toml
```

## Windows installation

Build and package the reviewed Windows x64 Host:

```powershell
npm run package:mdbx2-host
npm run package:verify:mdbx2-host
```

Extract `release/monica-mdbx2-host-windows-x64-<version>.zip`, copy the extension ID from `chrome://extensions` or `edge://extensions`, then run one of:

```powershell
.\install-host.ps1 -ChromeExtensionId <32-character-id>
.\install-host.ps1 -EdgeExtensionId <32-character-id>
.\install-host.ps1 -ChromeExtensionId <chrome-id> -EdgeExtensionId <edge-id>
```

The installer writes only under the current user's `%LOCALAPPDATA%` and `HKCU`. It creates exact `chrome-extension://<id>/` origins for both `com.monica_pass.mdbx2` and `com.monica_pass.windows_hello`, and never uses a wildcard. Fully exit and reopen the browser after installation. `uninstall-host.ps1` removes both per-user registry entries and the verified Host directory.

## Installation security

The native-host manifest contains the absolute executable path and only installer-supplied exact extension origins. The installer rejects malformed IDs. Chrome and Edge registration stays per user and does not require administrator privileges.

The Host writes protocol frames only to stdout. Diagnostics go to stderr and must never contain credentials, decrypted payloads, epoch keys, integrity keys, transfer ciphertext or user field values. Raw SQL is not exposed.

## 会话密钥保护（session.seal / session.unseal）

扩展的「会话超时」策略选择「浏览器重启时」或「从不」时，会把会话密钥交给 Host 用 Windows DPAPI（当前用户范围）加密后再写入扩展的 `storage.local`，磁盘上不会出现明文密钥。

- `session.seal`：`{ plaintextBase64 }` → `{ sealedBase64 }`，输入上限 128 字节（会话密钥为 32 字节）。
- `session.unseal`：`{ sealedBase64 }` → `{ plaintextBase64 }`，输入上限 4 KiB。
- 附加 entropy 固定为 `monica.extension.secureVault.session.v1`，并始终使用 `CRYPTPROTECT_UI_FORBIDDEN`。
- 边界说明：DPAPI 信任 Windows 登录会话，因此以同一用户身份运行的任何程序都能解开同一个 blob。该机制只保护静态存储（离线磁盘、其他账户、被复制的 profile 目录），不防御同账户恶意程序；这正是不选「从不锁定」时的既有取舍。
- Host 不保存、不记录也不向其他调用方转交该密钥；解封失败时扩展按“已锁定”处理（fail-closed）。

### 其他 Chromium 分支（Helium 等）

`install-host.ps1` 只写入 Chrome 与 Edge 的注册表键。其他 Chromium 分支使用自己的 vendor 路径，例如 Helium（imput）为：

```powershell
$manifest = Join-Path $env:LOCALAPPDATA "MonicaExtensionMDBX2com.monica_pass.mdbx2.json"
$helloManifest = Join-Path $env:LOCALAPPDATA "MonicaExtensionMDBX2com.monica_pass.windows_hello.json"
reg add "HKCUSoftware
et.imput.heliumNativeMessagingHostscom.monica_pass.mdbx2" /ve /t REG_SZ /d $manifest /f
reg add "HKCUSoftware
et.imput.heliumNativeMessagingHostscom.monica_pass.windows_hello" /ve /t REG_SZ /d $helloManifest /f
```

注册表默认值指向的清单里 `allowed_origins` 必须恰好是该浏览器的 `chrome-extension://<id>/`；注册后需完全退出并重新启动浏览器。

