# OpenTune Control Protocol (OTCP), version 1

Status: `1.0.0-rc.3`, draft. This release candidate defines the transport, the session, discovery, the result-clarity conventions and every method of version 1, in layers L2 to L6 and L8 (section 22).

OTCP is a local control interface built into OpenTune Standalone. A client on the same computer, for example an MCP server, uses it to perform operations that a person can perform in the OpenTune window and to receive clear, structured results. OTCP is JSON-RPC 2.0 over TCP on the loopback address, one JSON message per line.

## 0. Conventions

### 0.1 Requirement keywords

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

### 0.2 Terms

| Term        | Meaning                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| instance    | One running OpenTune Standalone process with the control API enabled.                                                    |
| server      | The control API inside an instance.                                                                                      |
| client      | A program that connects to the server.                                                                                   |
| connection  | One TCP connection from a client to the server.                                                                          |
| session     | A connection that has completed `session.hello`.                                                                         |
| line        | The bytes between two LF (0x0A) characters, excluding the LF.                                                            |
| main thread | The thread on which OpenTune runs its user interface and changes project state.                                          |
| content     | The audio, analysis, notes and pitch data of one clip source. Several placements can share one content.                  |
| placement   | A clip on the timeline: a window onto a content at a position on a track.                                                |
| track       | One of OpenTune's fixed track slots, addressed by position.                                                              |
| write       | A method that changes project, content, file or preference state (`write` is `yes` or `conditional` in its schema file). |
| read        | A method whose result describes project or content state (`resultKind` `read`).                                          |
| handle      | An identifier of an entity (section 9).                                                                                  |
| token       | An opaque revision value used to detect concurrent changes (section 10).                                                 |

### 0.3 Normative sources

This document, the schemas in `schemas/` and `methods/`, and the registries in `registry/` are normative. Vectors in `vectors/` are normative examples: a conforming server MUST produce responses that match them. Where a schema and this document disagree about the shape of a message, the schema is authoritative; where they disagree about behaviour, this document is authoritative. Either disagreement is a defect of the specification and SHOULD be reported.

Notation: `KIND(reason)` names an error with `data.kind` = KIND and `data.reason` = reason. JSON member names are written in `code` style.

## 1. Scope and non-goals

1. OTCP covers OpenTune Standalone only. Plug-in formats of OpenTune MUST NOT start the server.
2. OTCP exposes operations that the OpenTune Standalone user interface already offers, in the layers listed in section 22, and reads of the state behind them. It does not define operations that the user interface does not offer.
3. OTCP returns structured data only. The server produces no natural-language text for end users; clients render summaries from the structured results.
4. OTCP does not judge audio quality. It reports what an operation changed.
5. Features that OpenTune itself does not have (for example pan, a metronome, loop ranges, clip or track renaming, export format options) have no methods. A request for a method that is not defined returns `UNSUPPORTED(unknown_method)`; a defined method whose option would need such a feature returns `UNSUPPORTED(upstream_absent)`.
6. Layer L7 (drawing-style note and curve edits) is not defined in this version.
7. OTCP is not a remote protocol. It is reachable only from the same computer and, by its threat model, only by processes of the same operating-system user (SECURITY.md).

## 2. Versioning and compatibility

### 2.1 Version numbers

1. The specification is versioned `MAJOR.MINOR.PATCH`, released as tags `spec-vMAJOR.MINOR.PATCH`; release candidates carry the suffix `-rc.N` (for example `spec-v1.0.0-rc.1`).
2. On the wire only `MAJOR.MINOR` is carried (section 4). PATCH releases change wording, examples and vectors only, never behaviour or shapes.
3. This document is protocol major 1. All files of major 1 live in one directory named `v1`, which is copied unchanged into every repository that implements the protocol; a new major version gets a new directory.

### 2.2 Minor versions

A minor version MAY only add: methods, optional params members, result members, members of the discovery file and of the ready file (section 5), capabilities, error kinds, reasons, warnings, side-effect names, job kinds, entity names and enumerated string values. It MUST NOT remove or rename anything, or change the meaning or the unit of an existing member. Such changes need a new major version.

1. An optional params member added by a minor version MUST come with a new capability that a server reports exactly when it accepts the member. Clients send the member only to instances that report the capability, because servers reject unknown params members (section 2.3 rule 3) and clients do not decide by the minor version (section 2.3 rule 5).
2. The params of `session.hello` are frozen for major 1: no minor version adds, removes or changes a member of them. The hello is sent before the client can know the server's minor version, so a member the server does not know would make the hello fail (section 4.2).

### 2.3 Compatibility rules

1. Clients MUST ignore result members, discovery-file and ready-file members, side-effect names and capabilities they do not know.
2. Clients MUST accept error kinds, reasons, warning codes, entity names and enumerated string values they do not know. An unknown error kind MUST be handled like `INTERNAL`.
3. Servers MUST reject unknown params members with `INVALID_ARGUMENT(invalid_params)`; they MUST NOT ignore an option that the client may believe was applied.
4. The schemas in this directory are closed (they forbid undefined members) so that conformance tests detect mistakes in what a server sends. Rule 1 still applies to clients, because a newer minor version may add members; clients MUST NOT reject a message or a file only because it has members they do not know. Where a client validates input, it uses the open form of the schema where one is defined (for example `schemas/discovery-file.schema.json#/$defs/knownMembers`).
5. A client discovers what an instance supports from its capabilities (section 7), not from the minor version.

## 3. Transport and framing

### 3.1 Listener

1. The server MUST listen on TCP at the literal IPv4 address `127.0.0.1` and on a port chosen by the operating system (bind to port 0).
2. The server MUST NOT listen on any other address, including `0.0.0.0`, IPv6 addresses and addresses of virtual network adapters.
3. Clients MUST connect to the literal address `127.0.0.1` and the port from the discovery file (section 5). Clients MUST NOT resolve host names such as `localhost` and MUST NOT connect to other hosts.

### 3.2 Framing

1. Each message is one JSON value, encoded as UTF-8 without a byte order mark, followed by one LF. The message itself MUST NOT contain a raw LF; senders MUST NOT emit CR. Receivers MUST accept a CR immediately before the LF (it is JSON whitespace).
2. Lines are measured in bytes, excluding the LF.
3. A receiver MUST treat a line that is not valid UTF-8 or not valid JSON as a parse error. A JSON string, a member name included, whose escapes encode a lone surrogate is not valid JSON in this sense, because it encodes no Unicode text: a `\uD800` to `\uDBFF` escape that is not immediately followed by a `\uDC00` to `\uDFFF` escape, or a `\uDC00` to `\uDFFF` escape that does not immediately follow a `\uD800` to `\uDBFF` escape (letter case does not matter). This holds for every string in the line, also for one that a parser would drop, such as the first value of a member name that appears twice in an object (rule 5). Senders MUST NOT emit such escapes. The server MUST also treat nesting deeper than 64 arrays or objects as a parse error; the outermost value has depth 1. After authentication, the server answers a parse error with `INVALID_ARGUMENT(parse_error)` and `id` null and keeps the session open; before authentication, section 3.5 applies.
4. After authentication, the server MUST ignore lines that are empty or contain only JSON whitespace.
5. Senders SHOULD NOT emit duplicate member names in an object; the server SHOULD treat them as a parse error.

### 3.3 JSON-RPC profile

1. Messages follow JSON-RPC 2.0 with the restrictions below.
2. Requests flow only from client to server and responses only from server to client. The server sends no requests and no notifications. Version 1 has no server-initiated messages; long-running work is observed by polling `job.get` (section 12).
3. A request is an object with exactly the members `jsonrpc` (the string `"2.0"`), `id`, `method` and optionally `params`.
   - `id` MUST be a string or a number. A string `id` has 1 to 128 Unicode code points, counted after JSON escapes are decoded; bytes and UTF-16 code units are not what is counted. A number `id` MUST have an integer value from 0 to 2^53-1 (9007199254740991).
   - The value of a number `id` is decided after conversion to an IEEE 754 binary64 number (round to nearest, ties to even), as common JSON parsers produce it, not by how the number is written: `1.0` and `1e2` are the integer ids 1 and 100, while `1.5`, `-1` and `9007199254740992` are not valid ids. Clients SHOULD write number ids as plain integer literals.
   - `method` MUST be a string. Any string is a valid `method` member, including the empty string; whether it names a method is decided by rule 5.
   - `params`, when present, MUST be an object. Omitting it is the same as `{}`.
   - A response carries the `id` of its request, except where rule 5 gives it `id` null. It writes a string `id` as a JSON string with the same value, and a number `id` as its integer value in a plain JSON integer literal, without a fraction, an exponent or a sign: a request with `id` `1.0` is answered with `"id":1`. This applies to every response, including the fixed responses of Appendix A.
4. A notification is a JSON object that has no member `id`, whose `jsonrpc` is `"2.0"` and whose `method` is a string, whatever its other members. Clients MUST NOT send notifications. The server MUST NOT execute a notification and MUST NOT respond to it.
5. After authentication the server handles each line as follows; the first case that applies decides, and every error response in this list has `executed` false:
   1. The line is longer than `maxLineBytes`: `INVALID_ARGUMENT(line_too_long)` with `id` null, then the server closes the connection (section 3.4 rule 3).
   2. The line is empty or contains only JSON whitespace: ignored, no response (section 3.2 rule 4).
   3. The line is not valid UTF-8 or not valid JSON, also because a string escapes a lone surrogate, or is nested too deeply: `INVALID_ARGUMENT(parse_error)` with `id` null (section 3.2 rule 3), also when the line has an `id` member.
   4. The line is a JSON array (a JSON-RPC batch). Batches are not supported: one error response `INVALID_ARGUMENT(batch_unsupported)` with `id` null; none of the elements is executed.
   5. The line is a notification (rule 4): ignored, no response.
   6. The line is any other value that is not a valid request under rule 3: `INVALID_ARGUMENT(invalid_request)`. The response carries the value's `id` if the value is an object whose `id` member is valid under rule 3, otherwise `id` null.
   7. The `id` equals that of a request still in flight on the same session: `INVALID_ARGUMENT(duplicate_id)` with `id` null. Ids are compared by the values of rule 3, so the number `1.0` equals `1`, and a number never equals a string. The response has `id` null so that it cannot be mistaken for the response of the request in flight.
   8. `maxInFlightPerSession` requests are already in flight on the session: `BUSY(request_limit)` (section 3.4).
   9. `method` is not the name of a method defined by the session's protocol version (section 22), whatever the string is, for example `"foo"` or the empty string: `UNSUPPORTED(unknown_method)`. A `method` member that is missing or not a string is case 6.
   10. The instance does not report the method's capability: `UNSUPPORTED(capability_missing)`. An instance implements every method of every capability it reports, so a defined method that an instance does not implement always gives this error. The same applies when a member of `params` has a value for which the method's schema names a further capability (`x-otcp.valueCapabilities`, `methods/README.md`) and the instance does not report that capability.
   11. The method is `session.hello`: `INVALID_ARGUMENT(hello_repeated)` (section 4.4).
   12. `params` does not validate against the method's params schema: `INVALID_ARGUMENT(invalid_params)`.
   13. Otherwise the method runs. Its own checks follow, for writes in the order of section 13.1 rule 4.
6. The server starts requests in the order it receives them on a session, and requests that need the main thread are queued to it in that order, so the writes of one session take effect in the order they were sent. Responses MAY arrive in a different order (for example a `job.get` that waits); clients MUST match responses by `id`.
7. Each response is a success (`result`, always an object) or an error (`error`, section 17), never both.

### 3.4 Limits

| Limit                                                              | Value                                    | Member of `limits`      |
| ------------------------------------------------------------------ | ---------------------------------------- | ----------------------- |
| Bytes read before authentication                                   | 8192                                     | `preAuthReadBytes`      |
| Time from accept to a complete first line                          | 2000 ms                                  | `helloTimeoutMs`        |
| Connections not yet authenticated                                  | 8                                        | `maxPreAuthConnections` |
| Authenticated sessions                                             | 4                                        | `maxSessions`           |
| Line length after authentication, both directions                  | 4194304 bytes (4 MiB)                    | `maxLineBytes`          |
| Requests in flight per session                                     | 16                                       | `maxInFlightPerSession` |
| Idle time before the server closes a session                       | 600000 ms (10 minutes)                   | `idleTimeoutMs`         |
| Time a request may wait for the main thread before it is abandoned | implementation-defined, 1000 to 30000 ms | `dispatchTimeoutMs`     |
| Longest `job.get` wait                                             | 30000 ms                                 | `jobWaitMaxMs`          |
| Retention of a finished job                                        | 1800000 ms (30 minutes)                  | `jobRetentionMs`        |
| Retained jobs                                                      | 64                                       | `jobRetentionCount`     |

1. `session.hello` and `session.info` report these values in `limits`.
2. A request beyond `maxInFlightPerSession` is answered with `BUSY(request_limit)` and is not executed.
3. A line longer than `maxLineBytes` is answered with `INVALID_ARGUMENT(line_too_long)` with `id` null, after which the server closes the connection. The server answers as soon as it has received more than `maxLineBytes` bytes without an LF; it does not wait for the end of the line. The server MUST NOT send a line longer than `maxLineBytes`; reads that could exceed it are paginated.
4. A session is idle while it has no request in flight and has sent no complete line. After `idleTimeoutMs` of idleness the server closes the connection without a message.

### 3.5 Before authentication

On every accepted connection the server MUST apply these rules in order:

1. If `maxPreAuthConnections` connections are already waiting for authentication, close the new connection at once without sending a byte.
2. Read at most `preAuthReadBytes` bytes. If no complete line has arrived within `helloTimeoutMs` of the accept, or no LF appears within `preAuthReadBytes` bytes, or the peer closes, close the connection without sending a byte.
3. The first line MUST be a single JSON object that is a valid request (section 3.3 rule 3) for the method `session.hello`. Otherwise (for example an HTTP request, a JSON array, a notification or another method), close the connection without sending a byte.
4. Process `session.hello` as described in section 4.

These rules make the port useless for cross-protocol requests from web browsers: no request a browser can send is a valid first line, and such requests never receive a single byte back.

Clients MUST NOT send anything after the `session.hello` line until they have received and verified its response (section 4.3).

### 3.6 Closing

1. Either side MAY close a connection at any time. Requests in flight when a connection closes still run to completion, and their responses are discarded. Jobs are not cancelled by a closed connection (section 12).
2. When the server stops (for example because OpenTune exits), it MUST answer new requests with `SHUTTING_DOWN`, end every waiting `job.get` with `SHUTTING_DOWN`, then close all connections and the listener, and finally delete its discovery file (section 5.4).

## 4. Authentication and session

### 4.1 session.hello

The first request on a connection is `session.hello` (schema `methods/session.hello.schema.json`). Its params carry the `token` from the discovery file, the `protocol` version the client implements as `MAJOR.MINOR`, and a `client` name and version for diagnostics. Its result carries the server's `protocol` version, `instanceId`, `pid`, `serverProof`, `appVersion`, `flavor`, `capabilities` and `limits`.

### 4.2 Server checks

The server MUST check, in this order:

1. If `params` is absent or not an object, or `params.token` is not a string, or `params.protocol` is not a string of the form `MAJOR.MINOR` (`common.schema.json#/$defs/protocolVersion`), or the token does not equal the instance's token, send the fixed `AUTH_FAILED` response (Appendix A) and close the connection. The token comparison MUST take time independent of the content of the tokens (constant-time comparison) and MUST be performed whenever `params.token` is a string, whatever the other members are.
2. If the major of `protocol` is not in the instance's `protocolMajors`, send the fixed `PROTOCOL_MISMATCH` response (Appendix A) and close the connection.
3. If `params` does not validate against the `session.hello` params schema of that major, answer `INVALID_ARGUMENT(invalid_params)` and close the connection. Only a client that sent the right token gets this far, so this response may say what is wrong in `detail`.
4. If `maxSessions` sessions are already authenticated, answer `BUSY(session_limit)` with `retryable` true and close the connection.
5. Otherwise the connection becomes a session. The result's `protocol` is the server's `MAJOR.MINOR` for the requested major; the session uses that major.

Steps 1 and 2 look only at `token` and `protocol`. Every major version of OTCP keeps these two members of `session.hello` params with the same form and meaning, so that a client of another major, whose other hello params may differ, still receives `PROTOCOL_MISMATCH` rather than `AUTH_FAILED`. Within major 1 the hello params are frozen (section 2.2 rule 2).

The fixed responses are identical for every failure of their kind, apart from the echoed `id`, so that they reveal nothing about why authentication failed.

### 4.3 Client verification

Before sending any other request, the client MUST check that `serverProof`, `instanceId` and `pid` in the result equal the values in the discovery file it used. If any differs, the client MUST close the connection, MUST NOT send further requests to that port, and SHOULD report the instance as untrusted. This detects a different process listening on a port that a stale discovery file names.

### 4.4 Session rules

1. `session.hello` on an authenticated session is answered with `INVALID_ARGUMENT(hello_repeated)`, after which the server closes the connection.
2. A session is bound to its connection. There is no resumption; a client that reconnects authenticates again.
3. All sessions of an instance see the same project state and the same jobs.

### 4.5 Secrets

1. The token is at least 128 bits and the server proof exactly 128 bits, both from the operating system's cryptographically secure random number generator (for example `BCryptGenRandom` on Windows or `arc4random_buf` on macOS), encoded as lowercase hexadecimal. General-purpose pseudo-random generators and identifier generators MUST NOT be used for them. Both are created anew at every start of the server.
2. The token MUST NOT appear anywhere except in the discovery file and in `session.hello` params. The server proof MUST NOT appear anywhere except in the discovery file and in the `session.hello` result. In particular neither may appear in any other result, error, warning, job progress or result, log line, log read (`app.getLog`) or diagnostic output, of the server or of a client.
3. `instanceId` is a 128-bit random value encoded as 32 lowercase hexadecimal characters. It is not secret.

## 5. Discovery

### 5.1 Directory

The server writes one discovery file per instance into the discovery directory D, chosen as follows:

1. If the option `--control-api-dir=<path>` is given (section 6), D is that path.
2. Otherwise, if the environment variable `OPENTUNE_DATA_DIR` is set, D is `<OPENTUNE_DATA_DIR>/control/instances`.
3. Otherwise D is:
   - Windows: `%LOCALAPPDATA%\OpenTune\control\instances`
   - macOS: `~/Library/Application Support/OpenTune/control/instances`
   - other POSIX systems: `$XDG_STATE_HOME/OpenTune/control/instances`, where `$XDG_STATE_HOME` defaults to `~/.local/state`

The file name is `<pid>.json`, where `<pid>` is the decimal process id of the instance. Clients MAY let their user override the directory they read, so that tests stay isolated.

### 5.2 Writing the file

1. On POSIX systems the server MUST create missing directories of D with mode 0700. Before writing, it MUST verify that D is a directory and not a symbolic link, that it is owned by the effective user, and that it is not writable by group or others. If a check fails, the server MUST NOT start (section 6.4).
2. On POSIX systems the server MUST write the content to a new temporary file in D, opened with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600, flush it to disk, and then rename it to `<pid>.json`.
3. On Windows the server MUST create a new temporary file in D with an explicit discretionary access control list (DACL) that is protected from inheritance and grants access only to the user the process runs as (the user SID of its access token) and, optionally, to the operating system account `SYSTEM` (S-1-5-18). It MUST pass this security descriptor when it creates the file (for example in the `lpSecurityAttributes` of `CreateFileW` with `CREATE_NEW`), so that the file never exists with other access rights. It then writes the content, flushes it, and renames the file to `<pid>.json`, replacing any existing file of that name; a rename within one volume keeps the DACL. Like mode 0600 in rule 2, this protects the file whatever directory D is (section 5.1). The default D lies in the user's local application data folder, which only that user can access.
4. Temporary files MUST NOT end in `.json`. Clients ignore files whose names do not match `^[1-9][0-9]*\.json$`.
5. The file is written only after the listener accepts connections.

### 5.3 Content

The content is a JSON object defined by `schemas/discovery-file.schema.json`, at most 8192 bytes. Every member is always present; inapplicable values are null. A server writes exactly the members of its version, so the file validates against the closed schema. One file serves every major in `protocolMajors`; a later major keeps every member defined here with the same meaning and form, and may add members.

| Member               | Meaning                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `protocolMajors`     | Protocol majors this instance serves, ascending.                                                                  |
| `pid`                | Process id of the instance. Equal to the number in the file name.                                                 |
| `processStartTimeMs` | Start time of the process as reported by the operating system, in ms since the Unix epoch.                        |
| `instanceId`         | Random identifier of this start of the server (section 4.5).                                                      |
| `port`               | TCP port on `127.0.0.1`.                                                                                          |
| `token`              | Secret sent in `session.hello` (section 4.5).                                                                     |
| `serverProof`        | Value returned by `session.hello` for verification (section 4.3).                                                 |
| `launchNonce`        | Value of `--control-api-launch-nonce=`, or null.                                                                  |
| `appVersion`         | OpenTune version string.                                                                                          |
| `build`              | `{commit, tag}`: the full commit id of the source the binary was built from, and its version-control tag or null. |
| `buildTag`           | Distribution label of this binary (for example the tag of a published test build), or null.                       |
| `sourceUrl`          | Where the corresponding source code of this build can be obtained. Informational.                                 |
| `startedAtMs`        | When the listener started, in ms since the Unix epoch.                                                            |
| `flavor`             | Always `"standalone"`.                                                                                            |

### 5.4 Lifecycle and cleanup

1. On a normal stop the server MUST delete its discovery file after closing the listener. The server MUST NOT delete discovery files of other processes.
2. A file left behind by a process that ended abnormally is stale. A client considers a file stale when no process with `pid` is running, or when a process with `pid` is running but its start time differs from `processStartTimeMs` by more than 2000 ms (the process id was reused).
3. Clients MAY delete stale files. A client MUST NOT delete a file when it cannot determine that the file is stale, and MUST NOT connect to the port of a stale file.
4. Clients MUST ignore a file that is not a JSON object of at most 8192 bytes, that does not validate against `schemas/discovery-file.schema.json#/$defs/knownMembers` (every member defined by this version is present with the type and form the schema gives it), or whose `pid` differs from the file name. Clients MUST NOT ignore a file because it has members they do not know (section 2.3 rule 1); a newer minor version or another major served by the same instance may add members. The same applies to the ready file and `#/$defs/readyFileKnownMembers`.
5. More than one instance may run at once; each has its own file. Choosing among instances is the client's responsibility.

### 5.5 Ready file

If the option `--control-api-ready-file=<path>` is given, the server writes `{pid, instanceId}` (`schemas/discovery-file.schema.json#/$defs/readyFile`) to that path after the discovery file is in place, using a temporary file in the same directory and a rename that replaces any existing file of that name. The temporary file is created with the same protection as that of the discovery file: on POSIX systems with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600 (section 5.2 rule 2), on Windows with the DACL of section 5.2 rule 3. The ready file contains no secrets. A launcher uses it to learn which discovery file belongs to the process it started. If writing it fails, the server logs the failure and keeps running. On a normal stop the server MAY delete the ready file after its discovery file (section 5.4 rule 1). It MUST NOT delete it unless, read immediately before, the file still holds exactly the `pid` and `instanceId` that this instance wrote: a ready file that another process has written to the same path since, for example a later start with the same option, stays in place.

## 6. Enabling the control API

### 6.1 Build option

The control API is a build-time option of OpenTune (CMake option `OPENTUNE_ENABLE_CONTROL_API`, default off). A build without it contains no listener, writes no discovery file, and ignores the environment variables and command-line options of this section. This specification describes behaviour only; it does not prescribe how the option is implemented.

### 6.2 Run-time switch

In a build with the control API, the server starts only if the environment variable `OPENTUNE_CONTROL_API` has exactly the value `1`, or the command line contains the argument `--control-api`. Otherwise no port is opened and no discovery file is written. There is no preference setting that enables it.

### 6.3 Options

These command-line options are read only when the control API is enabled; otherwise they are ignored.

| Option                               | Value                                     | Effect                                                                                                   |
| ------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--control-api-dir=<path>`           | absolute directory path (section 20)      | Discovery directory D (section 5.1).                                                                     |
| `--control-api-ready-file=<path>`    | absolute file path (section 20)           | Ready file (section 5.5).                                                                                |
| `--control-api-launch-nonce=<value>` | 16 to 128 characters of `A-Z a-z 0-9 _ -` | Copied to `launchNonce` in the discovery file, so that a launcher can recognise the instance it started. |

The environment variable `OPENTUNE_DATA_DIR=<absolute path>` redirects OpenTune's preferences, logs and the default discovery directory to that directory. A build with the control API MUST honour it whether or not the API is enabled at run time, so that tests never touch the user's real settings. If the variable is set but is not an absolute path (section 20.1), the server MUST NOT start (section 6.4).

### 6.4 Start failure

If an option value is invalid, the discovery directory fails its checks, the listener cannot be opened or the discovery file cannot be written, the server MUST NOT start: no port stays open and no discovery file remains. OpenTune logs the reason and otherwise runs normally.

## 7. Capabilities and registries

1. Every method belongs to exactly one capability, declared in its schema file and in `methods/index.json`. `session.hello` and `session.info` report the instance's capabilities; a client MUST NOT call a method whose capability is not reported.
2. Every method schema file and every vector states `since`, the protocol version (`MAJOR.MINOR`) that introduced it.
3. Codes are registered in `registry/`:

| File                         | Codes                                                              | Used in                                                  |
| ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `registry/error-kinds.json`  | error kinds, with default JSON-RPC code and retryability           | `error.data.kind`                                        |
| `registry/reasons.json`      | reason codes, each scoped to an error kind, to `undo` or to `null` | `error.data.reason`, `undo.reason`, `nullReasons` values |
| `registry/warnings.json`     | warning codes                                                      | `warnings[].code`                                        |
| `registry/capabilities.json` | capability strings                                                 | `capabilities`, method schemas, vectors                  |

4. Each entry has `code`, `since` and `description`; registries are append-only within a major version (section 2.2). Every code a server sends MUST be registered for the protocol version of the session.
5. Clients MUST accept codes they do not know (section 2.3).

## 8. Clocks and units

### 8.1 Clocks

| Clock      | Meaning                                                                        | Used by                         |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------- |
| `content`  | Seconds of the source audio inside a content, before the time grid is applied. | Notes, pitch curves, analysis.  |
| `output`   | Content-local seconds after the time grid is applied.                          | Time-grid handles.              |
| `timeline` | Seconds of the arrangement.                                                    | Placements, transport, exports. |

1. Every time member names its clock: `<name><Clock>Sec`, for example `startContentSec`, `endTimelineSec`, `startOutputSec`. Durations, which do not depend on a clock, are `<name>Sec` (for example `durationSec`).
2. Every range input states its clock through its member names (`common.schema.json#/$defs/timeRange`); a range never carries a separate clock member.
3. Writes to notes are addressed by note index at a revision or by a `content` range, never by a `timeline` range.
4. Other writes that accept a `timeline` range MUST also take `expectedGridRevision` of the content and `expectedGeometryHash` of the placement through which the range is mapped (section 10), because both determine how timeline seconds map to content seconds.
5. Master and track exports start at timeline 0. A clip export starts at the clip's start on the timeline; its result reports `startTimelineSec`.

### 8.2 Units

The unit of every quantity is the suffix of its member name:

| Suffix      | Unit                     | Notes                                                                                                              |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `Sec`       | seconds                  | float; servers SHOULD round to 6 decimal places                                                                    |
| `Frame`     | analysis or audio frames | integer; the object also carries the frame length in seconds (`hopSec`) or the sample rate                         |
| `Midi`      | MIDI note number         | float; A4 = 69 at the instance's `tuningHz`                                                                        |
| `Hz`        | hertz                    | float                                                                                                              |
| `Cents`     | cents                    | float                                                                                                              |
| `Semitones` | semitones                | number                                                                                                             |
| `Db`        | decibels                 | float                                                                                                              |
| `Linear`    | linear gain factor       | float; placement gain and track volume carry both `Db` and `Linear` members                                        |
| `Ms`        | milliseconds             | integer; timestamps (`*AtMs`, `processStartTimeMs`) are ms since the Unix epoch, other `*Ms` members are durations |
| `Bytes`     | bytes                    | integer                                                                                                            |

Tempo is `bpm`, a time signature is `{numerator, denominator}` and colours are `#RRGGBB`.

A server rounds each kind of value in the same way in every result that reports it, so that a value a write result reports equals the value a later read returns (section 14.3). OpenTune's implementation of this protocol rounds `Midi` and `Cents` values to 4 decimal places.

Members without a physical unit carry no suffix: the normalized or dimensionless note parameters of section 8.3 (`retuneSpeed`, `vibratoDepth`, `pitchDriftScale`), whose ranges section 8.3 defines; `bpm`; counts (`*Count`), indexes and positions such as `trackId`; booleans, strings and enumerated values. Every other quantity has a suffix from the table.

### 8.3 Note parameters

| Member            | Range    | Meaning                                                                                                                                                                                                |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retuneSpeed`     | 0 to 1   | How quickly pitch is pulled to the target. 0 keeps the natural pitch contour; 1 flattens the note to the target (a mechanical sound). Some other pitch-correction products use the opposite direction. |
| `vibratoDepth`    | 0 to 100 | Added vibrato depth; 100 is plus or minus one semitone.                                                                                                                                                |
| `vibratoRateHz`   | 3 to 12  | Added vibrato rate.                                                                                                                                                                                    |
| `pitchDriftScale` | ratio    | Scale of the natural pitch drift; 1 keeps it unchanged.                                                                                                                                                |

## 9. Handles

| Handle        | Form                                                   | Rules                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contentId`   | `c:<instanceIdShort>:<contentEpoch>:<objectId>`        | `instanceIdShort` is the first 8 characters of `instanceId`. `contentEpoch` increases whenever the instance discards all contents at once, which happens when a project is opened.                                                                                                                                                 |
| `placementId` | `p:<instanceIdShort>:<contentEpoch>:<placementSerial>` | `instanceIdShort` and `contentEpoch` as for `contentId`. `placementSerial` is unique within the instance and epoch and never reused within an epoch.                                                                                                                                                                               |
| `trackId`     | integer, 0-based position                              | Positional. Deleting a track moves every later track down by one; every result that moves tracks returns `trackIdMap` (`[{before, after}]`, `after` null for the deleted track). The display label `Track N` (N = `trackId` + 1) is derived from the position.                                                                     |
| note          | `{index, atRevision}`                                  | `index` is the 0-based position of the note in the content's notes ordered by start time, at content revision `atRevision`; notes that start at the same time keep the order in which OpenTune stores them. Reads and write results count in this one order. Results add a `label` such as `#12 A4 41.20-41.85s` for display only. |
| `undoId`      | `u:<instanceIdShort>:<seq>`                            | Assigned by the server to every undo entry it creates, and to an entry created in the OpenTune UI when `edit.undo` or `edit.redo` applies it (section 15.3 rule 8); `seq` starts at 1 and increases.                                                                                                                               |
| `jobId`       | `j:<instanceIdShort>:<seq>`                            | `seq` starts at 1 and increases with every job of the instance.                                                                                                                                                                                                                                                                    |

1. The server resolves `contentId` and `placementId` in this order: form (else `INVALID_ARGUMENT(invalid_params)`), instance and epoch (a handle of another instance or of an earlier epoch gives `NOT_FOUND(stale_handle)`), existence (else `NOT_FOUND(unknown_handle)`). The type prefixes `c:`, `p:`, `u:` and `j:` make the forms of the four string handles disjoint, so a handle of one kind passed where another kind is expected always fails the form check.
2. A `jobId` of valid form that names no job the instance retains gives `NOT_FOUND(job_not_found)`, whatever its instance part: a job of another instance is simply not there (section 12). An `undoId` is only ever compared with the entries of the undo history (section 15.3); it is never resolved on its own.
3. A note handle whose `atRevision` is not the content's current revision gives `REVISION_CONFLICT(content_changed)`; an index outside the notes at that revision gives `NOT_FOUND(unknown_handle)`.
4. Handles are opaque apart from the rules above. Clients MUST NOT construct `contentId`, `placementId`, `undoId` or `jobId` values; they use values the server returned.

## 10. Revision tokens

| Token                                | Changes when                                                           | Expected-value param          |
| ------------------------------------ | ---------------------------------------------------------------------- | ----------------------------- |
| `revision` (per content)             | the `notes`, `pitch` or `content` component changes (section 14.4)     | `expectedRevision`            |
| `gridRevision` (per content)         | the time grid changes                                                  | `expectedGridRevision`        |
| `keyRevision` (per content)          | the content's key changes                                              | `expectedKeyRevision`         |
| `geometryHash` (per placement)       | the placement's track, timeline start, length or source window changes | `expectedGeometryHash`        |
| `arrangementRevision` (per instance) | placements are added, removed or changed in any property (14.4)        | `expectedArrangementRevision` |

1. Tokens are opaque strings. Clients MUST compare them only for equality, and MUST NOT order, parse or compute them.
2. `revision` covers the notes and their parameters, the corrected pitch curve, and the content's audio and analysis data. A change of the key, the time grid, the pitch shift, a reference binding or reference alignment data MUST NOT change `revision`. Section 14.4 maps every component of the world revision vector to these tokens. The pitch shift still moves values that reads report: OpenTune moves the notes with it, so `targetMidi` and `detectedMidi` of `content.getNotes` and `correctedMidi` of `content.getPitchCurve` include it, while notes keep their handles.
3. A write that takes an expected token compares it on the main thread immediately before it applies the change. On a mismatch it fails with `REVISION_CONFLICT` and the reason of the aspect: `content_changed`, `grid_changed`, `key_changed`, `geometry_changed` or `arrangement_changed`; `executed` is false.
4. A write depends only on the aspects it declares. Changes to other aspects MUST NOT cause a conflict; for example a key change does not invalidate `expectedRevision`.
5. Write results return in `tokens` the tokens of every object they touched, read back from a fresh snapshot after the commit. The server MUST NOT compute them, because one operation may advance a token more than once.
6. Pagination cursors are bound to the tokens of the read that issued them; using a cursor after the tokens changed gives `REVISION_CONFLICT(cursor_stale)`. The cursors of `content.getNotes` and `content.getPitchCurve` are also bound to the content's pitch shift (rule 2), so a page read after a pitch shift, or after its undo, never continues a read made before it.

## 11. Readiness gate

A content write (a method with capability `edit.v1` or `timing.v1` that targets a content) MUST fail with `NOT_READY` and change nothing while:

| Condition                                                 | Reason             | `retryable` |
| --------------------------------------------------------- | ------------------ | ----------- |
| pitch analysis has not been requested or is still running | `f0_not_ready`     | true        |
| pitch analysis failed                                     | `f0_failed`        | false       |
| pitch analysis finished without any voiced frame          | `f0_empty`         | false       |
| note generation for the content is still running          | `notes_generating` | true        |

The server SHOULD set `retryAfterMs` for retryable cases. Reads are never gated; they report the analysis state instead.

## 12. Jobs

Work that can take longer than a request should block runs as a job. The method that starts it returns at once with a job reference; the client follows the job with `job.get`.

### 12.1 Job object

The job object is `common.schema.json#/$defs/job`:

| Member                                       | Meaning                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId`, `kind`                              | Handle (section 9) and kind (table in 12.3).                                                                                                                                                                                                                                             |
| `state`                                      | `queued`, `running`, `succeeded`, `failed` or `cancelled`. The last three are terminal and never change again.                                                                                                                                                                           |
| `cancellable`                                | true if `job.cancel` would request cancellation now. false once cancellation was requested and in every terminal state.                                                                                                                                                                  |
| `createdAtMs`, `updatedAtMs`, `finishedAtMs` | Creation, last change of state or progress, and terminal time (null until terminal).                                                                                                                                                                                                     |
| `progress`                                   | `{fraction, phase, itemsDone, itemsTotal}`; members are null when unknown or not applicable.                                                                                                                                                                                             |
| `result`                                     | Kind-specific result defined by the starting method's schema (`$defs.jobResult`). null until terminal. For a job that changes project state, the result is a write envelope (section 14). A failed or cancelled job MAY carry a result that reports work it committed before it stopped. |
| `error`                                      | The error object (section 17) of a failed job, `CANCELLED(cancelled_by_request)` for a cancelled job, else null.                                                                                                                                                                         |

Jobs belong to the instance, not to a session: every session can read and cancel every job, and closing a connection never cancels a job.

The shape of `result` is defined by the method that started the job (`$defs.jobResult` of its schema), not by `kind`: `content.analyzeReference` and `content.autoTune` in mode `reference` both start `referenceAnalysis` jobs, with different results. A client knows the starting method from the request whose result gave it the `jobId`; a method that returns a job that is already running (section 12.5) returns only jobs that the same method started. A client or a test runner that reads a job without knowing which method started it, for example a job another session started, accepts a result that is valid for one of the methods that start jobs of that kind.

### 12.2 job.get

1. With `waitMs` absent or 0, or with a terminal job, `job.get` returns at once.
2. Otherwise the server holds the response until the job becomes terminal or `waitMs` elapses, whichever comes first, and then returns the job. It MAY return earlier when the job's progress changes. It MUST respond no later than `waitMs` + 1000 ms after receiving the request. `waitMs` above `jobWaitMaxMs` (30000) is invalid.
3. `job.get` never needs the main thread and never returns `BUSY` for UI reasons. When the server stops, waiting `job.get` requests end at once with `SHUTTING_DOWN`.

### 12.3 job.cancel and cancellation per kind

`job.cancel` (schema `methods/job.cancel.schema.json`) behaves as follows:

1. Unknown or no longer retained job, whatever the instance part of its `jobId` (section 9 rule 2): `NOT_FOUND(job_not_found)`.
2. Terminal job: success with `cancelRequested` false; nothing changes.
3. Cancellation already requested: success with `cancelRequested` true (idempotent).
4. Job not cancellable now (`cancellable` false): `UNSUPPORTED(job_not_cancellable)`; the job continues unchanged.
5. Otherwise: the server requests cancellation and answers with `cancelRequested` true and the job as it is then. Cancellation is asynchronous: the job stops at its next cancellation point and becomes `cancelled`, or `succeeded` if it finished first. Clients follow it with `job.get`.

| Kind                | Started by                                       | Cancellable                                                  | Effect of cancellation                                                                                                |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `import`            | `import.start`                                   | yes                                                          | Stops before the next item is committed. Items already committed stay; the job result lists them with revert recipes. |
| `export`            | `export.start`                                   | until the final rename of the output file                    | The temporary file is deleted; the target path is not touched.                                                        |
| `referenceAnalysis` | `content.analyzeReference`, reference-based AUTO | yes                                                          | The analysis is discarded.                                                                                            |
| `timeGridSeed`      | `content.editTimeGrid`                           | yes                                                          | No anchors are written.                                                                                               |
| `projectOpen`       | `project.open`                                   | until the project file has been read and prepared; not after | The current project is untouched.                                                                                     |
| `projectSave`       | `project.save`, `project.saveAs`                 | no                                                           | –                                                                                                                     |
| `prefsApply`        | `prefs.set`                                      | no                                                           | –                                                                                                                     |

### 12.4 Retention

A terminal job is retained for at least `jobRetentionMs` (30 minutes) after `finishedAtMs`, unless more than `jobRetentionCount` (64) jobs exist; then the terminal jobs that finished first are evicted first. Jobs that are not terminal are never evicted. If a new job cannot be retained because all 64 retained jobs are still active, the starting method fails with `BUSY(job_limit)`. `job.get` on an evicted job gives `NOT_FOUND(job_not_found)`.

### 12.5 Repeated requests

`export.start` with the same normalized params as an export job that is not terminal returns that job instead of starting a second one (section 19). `import.start` with the `idempotencyKey` of an import job that is still retained returns that job, so that a client can repeat a call whose response it lost without importing the files twice (its schema defines the rule). `content.analyzeReference` for a placement for which a job that `content.analyzeReference` started is not terminal returns that job; a `referenceAnalysis` job that `content.autoTune` started is never returned by it (section 12.1). Other methods start a new job on every call unless their schema says otherwise.

## 13. Concurrency, busy state and UI priority

### 13.1 Execution

1. Every operation that reads or changes project or content state runs on the main thread, one at a time, in the order the requests were received.
2. A request that has not started on the main thread within `dispatchTimeoutMs` is abandoned and answered with `TIMEOUT(dispatch_timeout)` with `executed` false. An abandoned request MUST never execute later; the server marks it abandoned before answering and checks the mark when the request would start.
3. Once a request has started on the main thread it runs to completion and returns its real result. Work that can take long runs as a job (section 12), so started requests finish quickly.
4. After the checks of section 3.3 rule 5, which include the capability and the params schema, a write checks, in this order: handles (section 9); busy state (13.2); the readiness gate (section 11); expected tokens (section 10); method-specific validation; then it applies the change. Each failed check returns its error with `executed` false.

### 13.2 Busy checks

A write is refused with `BUSY` and `executed` false, without waiting, while:

| Condition                                                       | Reason               |
| --------------------------------------------------------------- | -------------------- |
| the user is in the middle of a mouse or pen gesture in OpenTune | `pointer_down`       |
| a modal dialog is open in OpenTune                              | `modal_open`         |
| an import started from the OpenTune UI is running               | `import_in_progress` |
| an export holds the export lock (shared by the UI and this API) | `export_in_progress` |
| a project save or open is running                               | `project_operation`  |

These checks run on the main thread, immediately before the write applies. The server SHOULD set `retryAfterMs`. `ui.dismiss` is not refused because a dialog is open (`modal_open`), since closing dialogs is its purpose; the other conditions refuse it like every write.

### 13.3 Reads

1. Reads, `session.*` and `job.*` methods never return `BUSY` because of the UI and never wait for a UI operation to finish. They may still return `BUSY(request_limit)` (section 3.3).
2. A method runs on the main thread, and may therefore return `TIMEOUT(dispatch_timeout)`, exactly when its schema file says `mainThread: true` (`methods/README.md`). Every read of project or content state and `session.info` run on the main thread. `session.hello`, `job.get` and `job.cancel` never wait for the main thread and never return `TIMEOUT`.
3. All values in one read result come from one consistent state, taken in one main-thread step.

### 13.4 UI priority and residual windows

The person using OpenTune has priority: the server refuses rather than queues writes while the user is busy, and it never interrupts a gesture or closes a dialog on its own. Some interleavings remain possible, and clients MUST handle them:

1. User actions that set none of the busy conditions (keyboard shortcuts, menu commands, transport buttons) can happen between two requests. Expected tokens detect changes that a write depends on; every write result reports the state after the write.
2. The user can change state while a job runs. Exports detect content changes made while they write the file and fail without touching the target (section 19); import results report what was committed.
3. A gesture can start just after a write passed its busy check. Both run on the main thread in order, so the user's change is applied after the write and wins; the tokens the write returned are then stale and the next dependent write fails with `REVISION_CONFLICT`.
4. The user can undo any change from the OpenTune UI at any time, including changes made through this API. `edit.undo` and `edit.redo` therefore require `expectedUndoId` unless `force` is true (section 15.3).

## 14. Write result envelope

### 14.1 Members

Every write result is an object with all of the following members (`common.schema.json#/$defs/writeEnvelope`). No member is ever omitted.

| Member         | Type           | Meaning                                                                                                    |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `applied`      | boolean        | The call committed its change.                                                                             |
| `noOp`         | boolean        | The call succeeded but nothing changed.                                                                    |
| `dryRun`       | boolean        | The call only predicted its effect.                                                                        |
| `changes`      | array          | One entry per changed entity (14.3).                                                                       |
| `created`      | array          | Entities created: `{entity, ref, label}`.                                                                  |
| `removed`      | array          | Entities removed: `{entity, ref, label}`.                                                                  |
| `idMap`        | array          | Identity changes: `{entity, relation, from[], to[]}`, `relation` one of `split`, `merge`, `shift`, `copy`. |
| `revisionDiff` | object         | World revision vector difference (14.4).                                                                   |
| `tokens`       | object         | Tokens after the write (14.5).                                                                             |
| `undo`         | object or null | Undo descriptor (section 15).                                                                              |
| `dirty`        | object         | `{before, after}`: the project's unsaved-changes flag before and after the call.                           |
| `ui`           | object or null | Generic UI snapshot after the call (14.6).                                                                 |
| `sideEffects`  | object         | Effects beyond the targeted entities (14.6).                                                               |
| `warnings`     | array          | Warnings (section 18).                                                                                     |
| `job`          | object or null | `{jobId, kind, state}` when the call started or joined a job.                                              |

A write result MAY also carry `nullReasons` (section 16) and the method-specific members its schema defines (14.7).

### 14.2 States

Exactly one of these holds for every write result; `common.schema.json#/$defs/writeEnvelope` rejects every other combination:

| State                           | `applied` | `noOp` | `dryRun` | `job`         | `undo`                                                                 |
| ------------------------------- | --------- | ------ | -------- | ------------- | ---------------------------------------------------------------------- |
| committed with changes          | true      | false  | false    | null          | descriptor                                                             |
| committed without changes       | true      | true   | false    | null          | descriptor, usually `{undoable: false, reason: "no_op", revert: null}` |
| prediction (`dryRun` requested) | false     | false  | true     | null          | null                                                                   |
| work handed to a job            | false     | false  | false    | job reference | null                                                                   |

1. `noOp: true` is a success, not an error, and still reports the current state (for example setting the key a clip already has). `changes`, `created`, `removed` and `idMap` are empty. `dirty` can still change: for example an undo step that changes nothing is used up and marks the project as changed (section 15.3 rule 5).
2. A prediction lists the predicted `changes` and `sideEffects`; `revisionDiff` is empty, `tokens` are the current tokens, and `dirty.before` equals `dirty.after`.
3. When work is handed to a job, `changes`, `created`, `removed` and `idMap` are empty; the job's `result` carries the write envelope of the committed work.

### 14.3 changes[]

Each entry is `{entity, ref, label, fields}`:

- `entity` names the kind of entity: `note`, `placement`, `track`, `timeHandle`, `key`, `pitchShift`, `content`, `preference`, `tempo`, `transport`, `project`, `dialog`, `selection`, `audioDevice` (more MAY be added).
- `ref` identifies it with handles (`common.schema.json#/$defs/entityRef`). An entity of which the instance has exactly one (`transport`, `tempo`, `project`, `selection`, `audioDevice`) is referenced as `{singleton: <entity>}`, for example `{"singleton": "tempo"}`.
- `label` is a short display label generated from positions and values, or null. It never contains names taken from files or projects (section 20).
- `fields` maps each changed member name to `{before, after, unit}`, where `unit` is the member's unit suffix in lower case (`sec`, `frame`, `midi`, `hz`, `cents`, `semitones`, `db`, `linear`, `ms`, `bytes`), `bpm` for tempo, or null for members without a unit (section 8.2).

A note in `changes` or `created` is referenced at the content revision after the write, so that the reference can be used at once; a note in `removed` is referenced at the revision before the write, at which it existed. A prediction (`dryRun`) references notes at the current revision.

`after` is the value as OpenTune holds it after the commit, read back from the committed state and rounded as reads round it (section 8.2), never the requested value: it equals what a read right after the write returns, also where OpenTune adjusts a value while it commits it (section 15.4 rule 7). Note references in `changes` use the order of `content.getNotes` (section 9). A prediction reports the values it computed.

A write that changes many entities MAY be paginated by its method; the method schema then defines how the remainder is read.

### 14.4 revisionDiff

The world revision vector consists of the components below. The server captures it on the main thread immediately before and immediately after the write. `revisionDiff` lists only the components that differ: `{arrangement, trackState, contents[]}`, where `arrangement` and `trackState` are `{before, after}` or null, and each `contents[]` entry is `{contentId, changed}` with one `{before, after}` per changed component (`before` null for a new content, `after` null for a removed one).

| Component               | Covers                                                                                        | Values                       |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| `arrangement`           | the placements and their properties: position, length, source window, gain, fades, references | `arrangementRevision` values |
| `trackState`            | the states of all tracks: mute, solo, volume, colour, visibility                              | opaque hash                  |
| `contents[].notes`      | the notes and their parameters                                                                | opaque, part of `revision`   |
| `contents[].pitch`      | the corrected pitch curve                                                                     | opaque, part of `revision`   |
| `contents[].content`    | the content's audio and analysis data, for example a finished pitch analysis                  | opaque, part of `revision`   |
| `contents[].grid`       | the time grid                                                                                 | `gridRevision` values        |
| `contents[].key`        | the key                                                                                       | `keyRevision` values         |
| `contents[].pitchShift` | the clip pitch shift                                                                          | opaque                       |
| `contents[].reference`  | the content's reference alignment data                                                        | opaque                       |

1. `revision` changes exactly when the `notes`, `pitch` or `content` component changes; the values of these components are not `revision` values.
2. A change of a placement's geometry, and with it of its `geometryHash`, is an `arrangement` change; `geometryHash` has no component of its own.
3. Opaque component values are compared only for equality, like tokens. Clients MUST NOT send them as expected values.
4. Every write result MUST contain `revisionDiff`, including results of `edit.undo`, `edit.redo` and selection changes, so that no side effect on project state is hidden.
5. `revisionDiff` is empty when `arrangement` and `trackState` are null and `contents` is empty.
6. Every change that `revisionDiff` shows MUST be explained by `changes`, `created`, `removed` or `sideEffects`. In particular, a content that leaves the project because the write removed the last placement that showed it (deleting clips with `arrangement.edit`, deleting a track) is listed in `removed` as `{entity: "content", ref: {contentId}, label}`, after the removed placements, as new contents are listed in `created`.

### 14.5 tokens

`tokens` is `{arrangementRevision, contents[], placements[]}` with the tokens (section 10) of every content and placement the write touched, read back after the commit. A client uses them as expected values for its next write.

### 14.6 ui and sideEffects

`ui` is a generic snapshot of the OpenTune window after the call: `{workspace, pianoRollContentId, activeTrackId, selectedPlacementIds, visibleTrackCount}`, where `workspace` is `arrangement` or `pianoRoll`. It is null, with `nullReasons.ui` = `no_editor`, when no editor window exists.

`sideEffects` maps a side-effect name to an object describing it; it contains only effects that happened (an empty object means none). Each side effect carries `revert`, a revert recipe or null (section 15.2). Side effects are state changes that only the server can observe. Defined names:

| Name                      | Meaning                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `notesGenerated`          | OpenTune generated notes for a content (for example on selection in the `openDyne` scheme, section 21). |
| `referenceAnalysisQueued` | Reference alignment analysis was queued.                                                                |
| `reRenderQueued`          | Rendering of one or more contents was queued.                                                           |
| `uiScaleChanged`          | The scale shown in the transport bar changed.                                                           |
| `workspaceSwitched`       | The window switched between the arrangement and the piano roll.                                         |
| `tracksRevealed`          | Hidden tracks became visible.                                                                           |
| `dialogClosed`            | A dialog was closed.                                                                                    |
| `dialogCommitted`         | Closing a dialog committed its value.                                                                   |

The members of each side-effect object besides `revert` are defined with the methods that produce it.

### 14.7 Method-specific members

A method schema MAY add members to its write result besides the envelope members (for example `trackIdMap`). It composes the envelope with `allOf` and closes the result with `unevaluatedProperties: false`. Envelope member names are reserved.

## 15. Undo and revert

### 15.1 Undo descriptor

`undo` describes how the change can be taken back:

- Undoable: `{undoable: true, undoId, description, innerActions, steps}`. The change is one entry on OpenTune's undo history (`steps` is always 1: one call is one undo step), identified by `undoId`. `description` is the entry's description as OpenTune's history shows it. `innerActions` names the undo actions inside the entry; the names are implementation-defined and opaque to clients.
- Not undoable: `{undoable: false, reason, revert}`, where `reason` comes from the `undo` scope of `registry/reasons.json` (`ui_parity`, `no_upstream_undo`, `not_persisted_state`, `upstream_undo_defect`, `no_op`).

Undo entries created through this API use the same kinds of undo actions as the OpenTune UI, so the user can undo API changes from the OpenTune UI in the same way as their own.

### 15.2 Revert recipes

A revert recipe is `{method, params, requiresConsent}` (`common.schema.json#/$defs/revert`): a request that restores the state before the change. `requiresConsent` is optional and defaults to false. A recipe without `requiresConsent: true` is a complete request that restores the state when it is sent unchanged.

1. Whenever a change is not undoable but can be restored (for example the previous key, a track's previous volume, deleting imported clips), the server MUST provide a revert recipe in `undo.revert`.
2. `revert` is null only when no request of this protocol can restore the state. A recipe whose method needs a capability that the instance does not report cannot restore anything there, so on such an instance `revert` is null as well. A not-undoable change that can be neither undone nor reverted MUST carry the warning `IRREVERSIBLE`.
3. A revert recipe SHOULD carry the expected tokens of the state right after the change, so that it fails with `REVISION_CONFLICT` instead of overwriting later changes.
4. The `params` of a revert recipe MUST NOT contain any member by which a method takes the end user's consent (section 20.2 rule 3): `confirm`, any member whose name starts with `discard`, and any member that a later version defines for the same purpose. If the method of the recipe needs such consent to restore the state, the recipe carries `requiresConsent: true`. A client MUST NOT send such a recipe until the end user has explicitly agreed to that restoration; only then does the client add the method's consent members itself. A recipe never counts as consent, like any other part of a result.
5. Rules 1 to 4 apply equally to the revert recipes of side effects (`sideEffects.<name>.revert`, section 14.6).
6. View state is exempt from rules 1 and 2: the play state and the playback position, the loop flag, the selection, the workspace the window shows, the number of visible tracks, open dialogs and the scale shown in the transport bar. It is not saved with the project, OpenTune changes some of it by itself (the position moves during playback, the shown scale follows the selection), and the protocol restores it only where a method's schema gives a revert recipe. A change of view state has the undo reason `not_persisted_state` and carries no `IRREVERSIBLE` warning for that change. Rules 1 to 5 still apply to every other effect of the same call, for example to notes generated because a clip was selected, or to a colour committed because a dialog was closed.

### 15.3 edit.undo and edit.redo

1. `edit.undo` and `edit.redo` take `expectedUndoId`: the `undoId` of the entry the client expects on top of the undo (or redo) history. It is required unless `force` is true. With `force` true the server neither parses nor checks `expectedUndoId`, even when it is given, so a client may leave it out, for example when the top entry was created in the OpenTune UI and has no `undoId`.
2. Without `force`, if the top entry is not that entry (including an entry created in the OpenTune UI, which has no `undoId` until rule 8 assigns one), the call fails with `UNDO_CONFLICT(top_mismatch)` and changes nothing. With `force` true the server applies the top entry, whatever it is. If the history is empty, the call fails with `UNDO_CONFLICT(history_empty)`, also with `force`.
3. Clients MUST NOT set `force` unless the end user explicitly asked to undo or redo a change that was not made through the client. Once the client has applied such an entry at the end user's request, rule 8 lets it name the entry; it still undoes or redoes the entry again only when the end user asks.
4. If the top entry is a clip split, merge or delete, the call fails with `UNSUPPORTED(undo_unsafe_build)`, also with `force` (15.4).
5. If the step changes nothing (`revisionDiff` is empty), the result is a success with `applied: true`, `noOp: true` and the warning `UNDO_NO_EFFECT`. The step is still used up and the project is still marked as changed, as in the OpenTune UI.
6. Deleting a track (`track.delete`, or deleting a track in the OpenTune UI) is a barrier in the undo and redo histories: OpenTune keys clip entries by track position, and an entry recorded before the deletion may address a track that has moved since (section 15.4 rule 3). An entry is possibly stale when a track was deleted after the entry was recorded and no call with `force` has applied the entry since that deletion; `edit.getHistory` reports this as `possiblyStale`. The server cannot inspect an entry recorded in the UI, so every such entry recorded before a deletion is possibly stale. For an entry recorded through this API the server knows the tracks it addresses (the tracks of the clips it changed), and the entry is possibly stale only when a deletion removed one of these tracks or moved it down. An entry recorded through this API that addresses no track, such as a note edit, which addresses its content, or that addresses only tracks before the deleted one, is not possibly stale and is applied as usual, without a warning. When a deletion removed the content that an entry recorded through this API addresses (the deleted track held every clip that showed the content), the entry is applied as the OpenTune UI applies it: the step is used up and changes nothing, so the result has `noOp` true and the warning `UNDO_NO_EFFECT` (rule 5). Without `force`, a possibly stale entry recorded through this API fails with `UNDO_CONFLICT(stale_entry)`, and a possibly stale entry recorded in the UI (which has an `undoId` because a call with `force` applied it before, rule 8) is applied with the warning `UNDO_ENTRY_POSSIBLY_STALE`. A client can therefore tell from `origin` and `possiblyStale` which of the two happens before it calls. A call with `force` applies a possibly stale entry without that warning, since the end user asked for that step after seeing `possiblyStale`, and clears its `possiblyStale`: the end user has confirmed the entry, so later steps on it neither fail with `stale_entry` nor carry the warning, until another track deletion makes the entry possibly stale again. `track.delete` reports how many entries it made possibly stale. Opening a project clears both histories, and with them every barrier.
7. Like the UI, the server refreshes derived state after the step; any work this queues is reported in `sideEffects`.
8. When `edit.undo` or `edit.redo` applies an entry that has no `undoId` (an entry created in the OpenTune UI, applied with `force`), the server assigns it one and reports it in the result's `entry`; `edit.getHistory` shows it from then on. The entry keeps that `undoId` while it stays in the history and the server can confirm that it is the same entry. OpenTune's history holds a limited number of entries (500) and drops its oldest entry when a new one is added to a full history, which moves every entry by one position; a server that identifies entries recorded in the UI by their position then cannot confirm them any more and MAY withdraw the `undoId`s it assigned to such entries. A withdrawn entry has no `undoId` again (until a call with `force` applies it once more), and a call that names a withdrawn `undoId` fails with `UNDO_CONFLICT(top_mismatch)`, as for any entry that is not on top. The result's `entry` shows the entry as it is after the step. The revert recipe of every step (`edit.redo` for an undo, `edit.undo` for a redo) names the entry's `undoId` and never carries `force`. Because the entry has an `undoId` (this rule) and a call with `force` cleared its `possiblyStale` (rule 6), the recipe of a step applied with `force` is a complete request as well: sent unchanged while the entry is still on top, it takes back exactly the step the end user asked for (section 15.2).
9. Some changes of a content have no undo entry: those of writes that are not undoable, whether or not they give a revert recipe (for example `content.setKey`, `content.autoTune` in mode `notesOnly` and op `seed` of `content.editTimeGrid`), and notes generated as a side effect (section 21). No undo or redo step takes such a change back. Every undo entry recorded through this API puts back only the aspects of a content that its own change touched: the notes with the corrected pitch, the key, the pitch shift and the time grid. Once a change without an undo entry has changed one of these aspects of a content, the entries recorded through this API before it no longer put back that aspect of that content, so it keeps the value the change set; an entry recorded in the UI, which the server cannot inspect, is applied as OpenTune applies it. Such a change also clears the redo history, so that no redo step writes older values over it. A step that has nothing left to put back is used up and changes nothing: the result has `noOp` true and the warning `UNDO_NO_EFFECT` (rule 5). This differs from the OpenTune UI, which keeps its redo history when the key is changed there; a later release candidate may instead let redo steps skip the aspects that such a change touched, as undo steps do, and keep the redo history. Until then, clients assume that every change without an undo entry clears the redo history.

### 15.4 Known OpenTune behaviours

The protocol reports these behaviours of OpenTune as they are; it does not change them:

1. After a clip split, merge or delete, OpenTune frees objects that its undo entry needs, so undoing the entry does not restore the clips. The server pushes the same undo entry as the UI (so the UI behaves as before) and reports the change as `undo: {undoable: false, reason: "upstream_undo_defect", …}` with the warning `UPSTREAM_UNDO_DEFECT`; `edit.undo` and `edit.redo` refuse such entries (15.3 rule 4).
2. Undoing a clip trim in the UI does not restore fades that the trim shortened. Trims made through this API record the fades in the same undo entry, so their undo restores them; the result carries `FADES_RECLAMPED` when fades were shortened.
3. After a track is deleted, earlier clip undo entries may do nothing, while the UI still uses up the step. See 15.3 rules 5 and 6.
4. Closing the track-colour dialog, also with Escape, commits the colour shown. `ui.dismiss` refuses to close such a dialog with `INVALID_ARGUMENT(dialog_commits_on_close)` unless its params contain `confirm: true` (section 20.2 rule 3), and reports a commit with `DIALOG_CLOSE_COMMITTED`.
5. "Play from start" returns to the position of the last play or seek, not to 0. The transport methods document this.
6. Track names are not shown or saved by OpenTune; tracks are identified by position only (`Track N`).
7. When OpenTune commits notes, it shortens a note that overlaps the next one so that it ends where the next one starts. A write result reports the shortened `endContentSec`, because `after` is read back from the committed state (section 14.3); a prediction (`dryRun`) does not commit and therefore does not show it. OpenTune does not commit an edit of a note of zero duration: such an edit is predicted like any other, but its commit fails with `INTERNAL`. A later release candidate may give this case a reason of its own and let the prediction report it.

### 15.5 Dirty flag

After every change that is saved with the project, the server marks the project as changed, also where the OpenTune UI does not. `dirty` in the result reports the flag before and after the call.

## 16. Read conventions

1. Every read result carries `asOf` and `derived` (`common.schema.json#/$defs/readMeta`). `asOf` is `{arrangementRevision, contents[]}` with the tokens of the contents the result describes.
2. `derived` lists the paths of members whose values the server computed rather than read from OpenTune's state, for example `tracks[].label`. Paths use member names separated by `.`, with `[]` for array elements.
3. A value that is unavailable is null, and the enclosing object's `nullReasons` maps the member name to a reason from the `null` scope of `registry/reasons.json`. Members are never omitted. A null that has a defined meaning of its own (for example `job: null` in a write result) needs no entry in `nullReasons`.
4. Long lists are paginated with an opaque `cursor` bound to the tokens of the read (section 10 rule 6).
5. Results of `session.*` and `job.*` methods are not reads of project state and carry neither `asOf` nor `derived`.

## 17. Errors

### 17.1 Error object

An error response carries `error: {code, message, data}` (`common.schema.json#/$defs/errorObject`):

| Member              | Meaning                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`              | JSON-RPC error code (17.2).                                                                                                                                                                                                                        |
| `message`           | Equal to `data.kind`.                                                                                                                                                                                                                              |
| `data.kind`         | Error kind from `registry/error-kinds.json`. Clients branch on the kind only.                                                                                                                                                                      |
| `data.reason`       | Optional reason from `registry/reasons.json`, scoped to the kind. It refines the kind for diagnostics and for actionable messages.                                                                                                                 |
| `data.retryable`    | Whether repeating the same request later can succeed.                                                                                                                                                                                              |
| `data.retryAfterMs` | Optional hint: wait at least this long before retrying.                                                                                                                                                                                            |
| `data.detail`       | Diagnostic text in English, printable ASCII (U+0020 to U+007E), at most 1024 characters and therefore at most 1024 bytes. Clients MUST NOT parse it. It never contains secrets (section 4.5) or strings taken from files or projects (section 20). |
| `data.executed`     | false: the request changed nothing and will never run later. true: state may have changed; the client must re-read before deciding what to do.                                                                                                     |

### 17.2 JSON-RPC codes

Each kind has a default code in `registry/error-kinds.json`: `AUTH_FAILED` -32001, `PROTOCOL_MISMATCH` -32002, `INVALID_ARGUMENT` -32602, `INTERNAL` -32603, every other kind -32000. These reasons use their own code: `INVALID_ARGUMENT(parse_error)` -32700; `INVALID_ARGUMENT(invalid_request)`, `INVALID_ARGUMENT(batch_unsupported)`, `INVALID_ARGUMENT(duplicate_id)` and `INVALID_ARGUMENT(line_too_long)` -32600; `UNSUPPORTED(unknown_method)` -32601. Clients SHOULD NOT branch on the code.

### 17.3 Kinds

| Kind                | Typical cause                                                                         | `retryable` by default |
| ------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| `AUTH_FAILED`       | wrong token, or hello without a usable token or protocol (fixed response, closed)     | false                  |
| `PROTOCOL_MISMATCH` | unsupported protocol major (fixed response, connection closed)                        | false                  |
| `SHUTTING_DOWN`     | the server is stopping                                                                | false                  |
| `INVALID_ARGUMENT`  | malformed message or params, invalid path, missing confirmation                       | false                  |
| `NOT_FOUND`         | unknown or stale handle, unknown job, missing file                                    | false                  |
| `NOT_READY`         | analysis or note generation not finished (section 11), export wait exceeded           | true                   |
| `ANALYSIS_FAILED`   | pitch analysis failed                                                                 | false                  |
| `RENDER_FAILED`     | rendering failed after one retry                                                      | false                  |
| `MODEL_UNAVAILABLE` | a model or inference backend is missing                                               | false                  |
| `REVISION_CONFLICT` | an expected token does not match, or state changed during the operation               | false                  |
| `UNDO_CONFLICT`     | the undo history does not have the expected entry on top                              | false                  |
| `UNSAVED_CHANGES`   | the request would discard unsaved changes                                             | false                  |
| `ALREADY_EXISTS`    | the target exists and replacing it was not allowed                                    | false                  |
| `BUSY`              | the user, the UI or another operation holds the resource (section 13.2)               | true                   |
| `TIMEOUT`           | the request did not start before the dispatch deadline                                | true                   |
| `CANCELLED`         | the job was cancelled (job `error` only)                                              | false                  |
| `IO_ERROR`          | a file could not be read or written                                                   | false                  |
| `UNSUPPORTED`       | unknown method, missing capability, unsupported option or target, non-cancellable job | false                  |
| `INTERNAL`          | unexpected server error                                                               | false                  |

The value in each error instance is authoritative; for example `NOT_READY(f0_failed)` is not retryable.

### 17.4 executed

1. Every error that a check before the change produces (section 13.1 rule 4) has `executed` false.
2. `TIMEOUT` MUST have `executed` false, and the request MUST never run afterwards (section 13.1 rule 2).
3. An error after the change started (for example `INTERNAL` during a commit) has `executed` true unless the server rolled the change back completely.

## 18. Warnings

1. A warning is `{code, subject, data}`: `code` from `registry/warnings.json`, `subject` an entity reference or null, and `data` an object with code-specific values or null.
2. Warnings never indicate failure; they report something the client should know about a successful result.
3. The server sends no warning text; clients render warnings from the code, the subject and the data.
4. A result that is not undoable, is destructive or has side effects the client did not ask for MUST carry the warning that names this (for example `IRREVERSIBLE`, `UPSTREAM_UNDO_DEFECT`, `SELECTION_GENERATED_NOTES`), so that clients can state it first.

## 19. Export contract

`export.start` (schema `methods/export.start.schema.json`, status in section 22) writes a WAV file of a clip, a track or the master mix as a job. Its params are `kind` (`clip`, `track` or `master`), `target` (`{placementId}` for a clip, `{trackId}` for a track), `path` (absolute, `.wav`), `ifExists` (`error`, `rename` or `overwrite`; default `error`) and `allowDry` (default false). The contract exists so that an export never silently contains uncorrected ("dry") or outdated audio.

1. Before creating the job, the server validates `path` (section 20.1). An export that would hold no audio, a track export of a track without clips or a master export in which no clip is heard, fails at once with `INVALID_ARGUMENT(nothing_to_export)` and no job starts; a job whose clips are all removed while it waits fails with the same error.
2. The server MUST NOT write to a loaded source file or a media file of the current project, whatever `ifExists` says. Whether a target is such a file is decided by file identity (section 20.3), never by comparing path strings. The check is made before the job is created, in which case `export.start` fails with `INVALID_ARGUMENT(target_is_loaded_media)` and no job starts. It is made again for the name actually used immediately before the final rename, in which case the job fails with the same error, the temporary file is deleted and the target is not touched.
3. The output is moved into place by the final rename of section 20.4, which depends on `ifExists`:
   - `error`: a rename that never replaces. If it fails because the target exists, the job fails with `ALREADY_EXISTS(target_exists)`. The server MUST also fail `export.start` at once with `ALREADY_EXISTS(target_exists)`, and create no job, if the target already exists when the job would be created, so that no rendering is wasted and the client gets the answer at once; this early answer never takes the place of the rename's own failure.
   - `rename`: a rename that never replaces, first to the target path and then, each time it fails because the name exists, to the next of `<stem> (2).wav`, `<stem> (3).wav`, … `<stem> (999).wav`, where `<stem>` is the target's file name without `.wav`. Rule 2 applies to every name before it is tried. If `<stem> (999).wav` exists as well, the job fails with `ALREADY_EXISTS(target_exists)`. The result's `path` is the name that was written.
   - `overwrite`: a rename that replaces an existing target.
4. The UI and this API share one export lock. While it is held, `export.start` fails with `BUSY(export_in_progress)`.
5. A call with the same normalized params as an export job that is not terminal returns that job (section 12.5).
6. For every content in the export, a main-thread timer decides:
   - pitch analysis not finished: wait;
   - analysis found no voiced audio, or the content has nothing to render: export that content uncorrected and list it in `dryContents[]` of the result;
   - analysis failed for another reason: fail with `ANALYSIS_FAILED(f0_failed)`, unless `allowDry` is true, in which case export it uncorrected and list it in `dryContents[]`;
   - a render block failed: queue it again once; if it fails again, fail with `RENDER_FAILED(render_chunk_failed)`;
   - render work pending: wait;
   - otherwise the content is ready only when its audible render is settled at its current revision;
   - a content whose time grid is not the identity is played and exported from time-stretched audio, which OpenTune builds from the settled render. Such a content is ready, or is exported uncorrected, only once that audio is built at its current revision and time grid; until then the job waits. A content of this kind that the cases above would export uncorrected has no render to stretch, so the job fails at once with `NOT_READY(export_dry_stretched)` (not retryable: it fails again until the time grid is the identity again); a stretched audio that the server asked OpenTune to build, an implementation-defined number of times, without getting it fails the job with `NOT_READY(export_stretch_dropped)` (retryable).
7. If the contents are not all ready within 120 s of the start of the job, whichever case of rule 6 they are waiting in, the job fails with `NOT_READY(export_wait_timeout)` and the target is not touched.
8. The server starts writing only after all contents are ready. In the same main-thread step in which the timer of rule 6 finds them all ready, it records the revision of every content; revisions that changed earlier, while the job waited (for example because an analysis finished), are no conflict. It writes to a temporary file in the target directory. When the file is written, back on the main thread, it compares the revisions with those it recorded: if any changed, the job fails with `REVISION_CONFLICT(changed_during_export)`, the temporary file is deleted and the target is not touched. Otherwise it repeats the check of rule 2 and performs the final rename of rule 3.
9. Cancellation is possible until the final rename (section 12.3).
10. The result reports the final `path`, `sampleRateHz` (44100), the channel count (1 for clip and track exports, 2 for the master mix), `sampleFormat` (`float32`), `durationSec`, `startTimelineSec` (0 for master and track exports, the clip start for clip exports, section 8.1), `dryContents[]`, `contents[]` with the revision of every content in the file as rule 8 recorded it, and `processing` with the vocoder weight, hybrid mode, backend and `tuningHz` that produced it.
11. The reasons `nothing_to_export` (rule 1), `export_dry_stretched` and `export_stretch_dropped` (rule 6) were added in `1.0.0-rc.3`. An implementation of this release candidate may still send these errors without a reason, and may end the `export_dry_stretched` case with `ANALYSIS_FAILED(f0_failed)` when the content's analysis failed; clients rely on the error kind and on `retryable` (section 17.1).

Hybrid mode (informative). `processing.hybridMode` of `prefs.get`, `session.info` and the export result is a boolean only. With hybrid mode on, OpenTune renders a correction smaller than a threshold with a pitch shift of the audio instead of resynthesizing it with the vocoder, so the corrected pitch curve and the note targets that results report can differ from what is heard and from what an analysis of the exported file measures. The threshold comes from OpenTune's implementation (75 cents at the time of writing) and is not part of this protocol, so clients do not rely on its value. A client that reports corrected pitch as the result of corrections should say that hybrid mode is on without quoting a threshold; OpenTune MCP Server, for example, adds a warning to its pitch analysis that names no number.

## 20. Paths and untrusted strings

### 20.1 Paths

OpenTune's checks are authoritative. Clients SHOULD check and normalize paths before sending them, but the server never normalizes: it accepts a path exactly as given or rejects it. The server MUST validate the path string itself before any file-system access, so that a rejected path touches nothing.

Windows, checked in this order:

| Rule                                                                | Reason                   |
| ------------------------------------------------------------------- | ------------------------ |
| no control characters (U+0000 to U+001F)                            | `path_invalid_character` |
| does not start with `\\?\` or `\\.\`                                | `path_device_namespace`  |
| does not start with `\\`                                            | `path_unc`               |
| a drive letter and colon are followed by a backslash (not `C:file`) | `path_drive_relative`    |
| matches `^[A-Za-z]:\\`                                              | `path_not_absolute`      |
| no further `:` (alternate data streams)                             | `path_alternate_stream`  |
| no `/`, and no empty, `.` or `..` segment                           | `path_not_normalized`    |
| no segment that ends in `.` or a space                              | `path_not_normalized`    |
| no segment with a reserved device name                              | `path_reserved_name`     |

Segments are the parts between backslashes after the drive. Windows removes trailing dots and spaces from a segment, so such a path would reach a file other than the one named. A segment has a reserved device name when the part before its first `.`, without trailing spaces and compared without regard to case, is `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM0` to `COM9`, `LPT0` to `LPT9`, or `COM`/`LPT` followed by `¹`, `²` or `³`; Windows maps such names to devices, also with an extension (for example `NUL.wav`).

POSIX: no control characters (`path_invalid_character`); starts with `/` (`path_not_absolute`); no empty, `.` or `..` segment (`path_not_normalized`).

Extensions, compared without regard to case (`path_bad_extension`): exports accept only `.wav`; saving and opening projects accept only `.otproj`; imports accept the extensions in `session.info` `import.extensions`. The paths given to `--control-api-dir=` and `--control-api-ready-file=` follow the same rules.

### 20.2 Untrusted strings

1. Track, clip, file and project names, file metadata, paths and log lines come from files and projects that may contain text written to manipulate an AI. The server returns them only as JSON string values of members defined for them. It MUST NOT place them in `label`, `detail`, warning codes or any member meant for display composed by the server.
2. Clients MUST treat these strings as data, never as instructions. A destructive operation requires the end user's consent; text from a result never counts as consent, and revert recipes never carry it (section 15.2 rule 4).
3. Operations that destroy work beyond undo need an explicit param. `track.delete`, `arrangement.edit` with op `delete`, and `project.saveAs` when its target is an existing file other than the current project file, fail with `INVALID_ARGUMENT(confirm_required)` and change nothing unless params contain `confirm: true`. `ui.dismiss` closes a dialog whose closing commits the value it shows only with `confirm: true`; otherwise it fails with `INVALID_ARGUMENT(dialog_commits_on_close)` and closes nothing. A method that would discard unsaved changes, such as `project.open`, fails with `UNSAVED_CHANGES(project_dirty)` unless its params explicitly allow discarding them (`discardUnsaved: true`). A prediction (`dryRun: true`) changes nothing and needs none of these params. The method schemas define these params; every params member that expresses consent is named `confirm` or starts with `discard`. Clients set them only when the end user explicitly agreed to that operation.
4. For `project.saveAs`, whether the target is the current project file, another existing file or no file is decided by file identity (section 20.3), when the request is validated and again immediately before the final rename. Without `confirm: true`, the final rename never replaces a file other than the current project file (section 20.4); if such a file has appeared at the target in the meantime, the job fails with `INVALID_ARGUMENT(confirm_required)`, the temporary file is deleted and the target is not touched.
5. `app.getLog` removes the token, the server proof and the user's home directory from the lines it returns.

### 20.3 File identity

Rules that ask whether a path names a particular file (section 19 rule 2 and section 20.2 rule 4) compare file identities, never path strings, because different strings can name the same file: letter case, short names, symbolic links, junctions, mount points and hard links.

1. The identity of an existing file or directory is, on Windows, the volume serial number together with the file id, as returned for a handle opened on the path by `GetFileInformationByHandle` (`dwVolumeSerialNumber`, `nFileIndexHigh` and `nFileIndexLow`) or by an equivalent call, such as `GetFileInformationByHandleEx` with `FileIdInfo`, which file systems with 128-bit file ids need; on POSIX systems it is `st_dev` together with `st_ino` as returned by `stat`. Symbolic links are followed, so a link has the identity of the file it points to.
2. Two existing files are the same file exactly when their identities are equal. A hard link to a file is therefore that file.
3. A path at which no file exists has no identity, so rule 2 does not apply to it. Instead, such a path names the same file as another path when the parent directories of both paths exist and have equal identities and the last segments of both paths are equal, compared as the file system compares names (on Windows without regard to case). This is how a target is compared with a media file of the project that is missing.
4. If an identity that a check needs cannot be determined for a reason other than the file not existing, the check fails: the operation is refused with `IO_ERROR(read_failed)` and changes nothing. This includes a loaded source file or project media file on a volume that is not available (for example a removed drive or a disconnected network share): the check of section 19 rule 2 cannot exclude that the target names that file, so every export is refused until the volume is available again or the file is no longer loaded. Clients report this as a problem with the loaded media, not with the target path.
5. A check is made when the request is validated and again on the main thread immediately before the final rename (section 20.4). The result of the first check never stands in for the second.

### 20.4 Final rename

Exports and project saves write to a temporary file in the target directory and then move it to the target path with one rename, so the rename never moves data between volumes. Where the target must not be replaced, the server MUST NOT test whether the target exists and then rename, because a file can appear between the two steps. It MUST use a rename that fails atomically when the target exists:

| System           | Rename that never replaces                                                        | Rename that replaces                           |
| ---------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| Windows          | `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`                                 | `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` |
| Linux            | `renameat2` with `RENAME_NOREPLACE`                                               | `rename`                                       |
| macOS            | `renamex_np` with `RENAME_EXCL`                                                   | `rename`                                       |
| any POSIX system | `link` from the temporary file to the target, then `unlink` of the temporary file | `rename`                                       |

The server MAY use the last row on any POSIX system, for example on a file system that does not support `RENAME_NOREPLACE`.

1. A rename that fails because the target exists leaves the target untouched; what happens next is defined by the operation (section 19 rule 3, section 20.2 rule 4).
2. If the file system of the target supports none of the renames that never replace (for example a file system without hard links on which `RENAME_NOREPLACE` is not supported), the operation fails with `IO_ERROR(write_failed)`, the temporary file is deleted and the target is not touched. The server MUST NOT fall back to a test followed by a rename that replaces.

## 21. Editing schemes

OpenTune has two editing schemes, selected in its preferences and reported as `session.info` `processing.editingScheme`:

| Wire value | Name in OpenTune | Primary edited object                        |
| ---------- | ---------------- | -------------------------------------------- |
| `openTune` | OpenTune         | the corrected pitch curve                    |
| `openDyne` | OpenDyne         | notes; the corrected curve follows the notes |

The scheme changes what some operations do. The protocol never hides these differences; results report what happened:

1. **AUTO.** `content.autoTune` takes an explicit `mode` and never infers it from the scheme. The AUTO button in OpenTune runs regeneration in the `openTune` scheme and snapping of existing notes in the `openDyne` scheme; a clip with a reference binding may make the button run reference alignment instead. `content.getDetails` reports which mode the button would run, as a mode of `content.autoTune`. An instance that does not report `reference.v1` has no such mode, so it reports `regenerate` even where the button would run reference alignment: OpenTune does so in the `openTune` scheme, with the experimental features on, for a clip whose reference binding was left on it (for example by a project saved with the experimental features on). A client that tells the end user what the button does checks `reference.referencePlacementId` of `content.getDetails`, which every instance reports, and `session.info` `processing.experimentalFeatures`.
2. **Focus on import.** `import.start` selects the last imported clip by default, as the UI does. In the `openDyne` scheme, a focused clip whose analysis finishes gets notes generated even when the request did not ask for note generation; this has no undo entry and marks the project as changed. The job result reports `notesGenerated` and `notesGeneratedBy` (`request` or `focus`). `focus: false` avoids it. The UI's import generates notes for every clip it imports in the `openDyne` scheme; `import.start` deliberately generates them only for the focused clip, or for every clip with `generateNotes`, so that the request decides which notes are generated.
3. **Selection.** In the `openDyne` scheme, selecting or opening a clip whose analysis is finished and whose notes were never generated makes OpenTune generate them, with no undo entry, and marks the project as changed. `ui.setSelection` reports this in `sideEffects.notesGenerated` with the warning `SELECTION_GENERATED_NOTES`, and with `dryRun` it predicts it without selecting.
4. **Changing the scheme.** Switching to `openDyne` with `prefs.set` may generate notes for the clip open in the editor; the result reports it in `sideEffects.notesGenerated` with the warning `SCHEME_GENERATED_NOTES`.
5. Other methods behave the same in both schemes unless their schema says otherwise.

## 22. Layers and method index

| Layer | Content                                                               | Capabilities                                                               |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| L2    | Reads: session, project, contents, transport, preferences, log        | `session.v1`, `read.v1`                                                    |
| L3    | Jobs, import, export, UI state and dialogs                            | `jobs.v1`, `import.v1`, `export.v1`, `ui.bridge`                           |
| L4    | Key, AUTO, note edits, pitch shift, undo and redo                     | `edit.v1`, `history.v1`                                                    |
| L5    | Timing: section shifts and time-grid handles                          | `timing.v1`                                                                |
| L6    | Arrangement, tracks, transport control, selection, reference analysis | `transport.v1`, `arrangement.v1`, `tracks.v1`, `ui.bridge`, `reference.v1` |
| L7    | Drawing-style note, curve, EQ and envelope edits                      | not defined in this version                                                |
| L8    | Project save and open, preference changes, audio device               | `project.io`, `prefs.write`, `audio.device`                                |

`ui.onboardingClose` is an additional capability of `ui.dismiss`: without it, `ui.dismiss` can prevent the first-run overlay but not close one that is already showing.

Every method of version 1 (also in `methods/index.json`). Write: `yes` changes state, `conditional` changes state only for some params or as a reported side effect, `no` never does. Schema: `defined` means `methods/<method>.schema.json` is normative; `pending` means the schema is added before the `1.0.0-rc.1` tag; `planned` means it is added in a later `1.0.0` release candidate. Until its schema is defined, a method has no normative shape: an implementation MAY provide it provisionally, following this document, for development against a release candidate, and MUST change it to match the schema once the schema is defined. Since `1.0.0-rc.2` every method in this table has a defined schema.

| Method                     | Layer | Capability       | Write       | Since | Schema  | Purpose                                                                                    |
| -------------------------- | ----- | ---------------- | ----------- | ----- | ------- | ------------------------------------------------------------------------------------------ |
| `session.hello`            | L2    | `session.v1`     | no          | 1.0   | defined | Authenticate and negotiate the version.                                                    |
| `session.info`             | L2    | `session.v1`     | no          | 1.0   | defined | Build, runtime, device, processing settings, capabilities, import and export capabilities. |
| `project.get`              | L2    | `read.v1`        | no          | 1.0   | defined | Tracks, placements, selection, transport, history, project path and dirty flag.            |
| `content.getNotes`         | L2    | `read.v1`        | no          | 1.0   | defined | Notes with times, detected and target pitch, parameters.                                   |
| `content.getPitchCurve`    | L2    | `read.v1`        | no          | 1.0   | defined | Original and corrected pitch curves, paginated.                                            |
| `content.segmentNotes`     | L2    | `read.v1`        | no          | 1.0   | defined | Read-only note segmentation of the original pitch, for analysis.                           |
| `content.getDetails`       | L2    | `read.v1`        | no          | 1.0   | defined | Key, pitch shift, analysis and render state, time grid, reference, AUTO modes.             |
| `transport.get`            | L2    | `read.v1`        | no          | 1.0   | defined | Play state, position, tempo, time signature, loop flag.                                    |
| `prefs.get`                | L2    | `read.v1`        | no          | 1.0   | defined | Preferences and recent projects.                                                           |
| `app.getLog`               | L2    | `read.v1`        | no          | 1.0   | defined | Tail of OpenTune's log, redacted.                                                          |
| `job.get`                  | L3    | `jobs.v1`        | no          | 1.0   | defined | Read a job, optionally waiting up to 30 s.                                                 |
| `job.cancel`               | L3    | `jobs.v1`        | no          | 1.0   | defined | Request cancellation of a job.                                                             |
| `import.start`             | L3    | `import.v1`      | yes         | 1.0   | defined | Import audio files (single, sequential, one track per file) as a job.                      |
| `export.start`             | L3    | `export.v1`      | yes         | 1.0   | defined | Export a clip, a track or the master mix as a job (section 19).                            |
| `ui.getState`              | L3    | `ui.bridge`      | no          | 1.0   | defined | Busy state, dialogs, view, selection.                                                      |
| `ui.dismiss`               | L3    | `ui.bridge`      | conditional | 1.0   | defined | Close dialogs or the first-run overlay.                                                    |
| `content.setKey`           | L4    | `edit.v1`        | yes         | 1.0   | defined | Set a clip's key (not undoable, with revert recipe).                                       |
| `content.autoTune`         | L4    | `edit.v1`        | yes         | 1.0   | defined | AUTO on ranges with an explicit mode, scale and parameters.                                |
| `content.editNotes`        | L4    | `edit.v1`        | yes         | 1.0   | defined | Target pitch, cent shift, snap and parameters of selected notes.                           |
| `content.setPitchShift`    | L4    | `edit.v1`        | yes         | 1.0   | defined | Clip pitch shift.                                                                          |
| `edit.getHistory`          | L4    | `history.v1`     | no          | 1.0   | defined | Top entries of the undo and redo history.                                                  |
| `edit.undo`                | L4    | `history.v1`     | yes         | 1.0   | defined | Undo the expected entry (section 15.3).                                                    |
| `edit.redo`                | L4    | `history.v1`     | yes         | 1.0   | defined | Redo the expected entry (section 15.3).                                                    |
| `content.shiftTiming`      | L5    | `timing.v1`      | yes         | 1.0   | defined | Shift a section earlier or later.                                                          |
| `content.editTimeGrid`     | L5    | `timing.v1`      | yes         | 1.0   | defined | Seed time-grid anchors (job) and move handles.                                             |
| `transport.control`        | L6    | `transport.v1`   | yes         | 1.0   | defined | Play, pause, stop, seek.                                                                   |
| `transport.setTempo`       | L6    | `transport.v1`   | yes         | 1.0   | defined | Tempo and time signature.                                                                  |
| `transport.setLoop`        | L6    | `transport.v1`   | yes         | 1.0   | defined | Loop flag.                                                                                 |
| `arrangement.edit`         | L6    | `arrangement.v1` | yes         | 1.0   | defined | Move, trim, gain, fades, split, merge, delete, reference binding.                          |
| `arrangement.copy`         | L6    | `arrangement.v1` | yes         | 1.0   | defined | Copy or duplicate clips.                                                                   |
| `track.set`                | L6    | `tracks.v1`      | yes         | 1.0   | defined | Mute, solo, volume, colour.                                                                |
| `track.add`                | L6    | `tracks.v1`      | yes         | 1.0   | defined | Show more tracks.                                                                          |
| `track.duplicate`          | L6    | `tracks.v1`      | yes         | 1.0   | defined | Duplicate a track.                                                                         |
| `track.delete`             | L6    | `tracks.v1`      | yes         | 1.0   | defined | Delete a track (irreversible).                                                             |
| `ui.setSelection`          | L6    | `ui.bridge`      | conditional | 1.0   | defined | Select or open a clip, with predicted side effects.                                        |
| `content.analyzeReference` | L6    | `reference.v1`   | no          | 1.0   | defined | Reference alignment analysis as a job.                                                     |
| `project.save`             | L8    | `project.io`     | yes         | 1.0   | defined | Save the project as a job.                                                                 |
| `project.saveAs`           | L8    | `project.io`     | yes         | 1.0   | defined | Save under a new path; replacing another project needs confirmation.                       |
| `project.open`             | L8    | `project.io`     | yes         | 1.0   | defined | Open a project as a job; never saves implicitly.                                           |
| `project.clearRecent`      | L8    | `project.io`     | yes         | 1.0   | defined | Clear the recent-projects list.                                                            |
| `prefs.set`                | L8    | `prefs.write`    | yes         | 1.0   | defined | Change processing preferences (user-global, with revert values).                           |
| `audio.get`                | L8    | `audio.device`   | no          | 1.0   | defined | Audio device settings.                                                                     |
| `audio.set`                | L8    | `audio.device`   | yes         | 1.0   | defined | Change the audio device, with rollback on failure.                                         |

## 23. Method schema files and test vectors

1. Each method has one file `methods/<method>.schema.json`, a JSON Schema 2020-12 document with the params and result schemas (and, for a method that starts a job, the job's result) in `$defs` and the method's metadata (layer, capability, `since`, write, result kind, job kind, whether it runs on the main thread, possible error kinds of the method and of its job) in the annotation `x-otcp`. The format is defined in `methods/README.md` and `schemas/method-file.schema.json`.
2. Test vectors in `vectors/` describe requests with expected responses and multi-step scenarios, with preconditions and with matchers for values that differ between runs. The format is defined in `vectors/README.md` and `schemas/vector.schema.json`. Every method with a defined schema has at least one success vector, and the behaviours listed in `vectors/README.md` ("Coverage") each have a vector.

## Appendix A. Fixed responses

The server sends these lines exactly, with `<id>` replaced by the request's `id` as section 3.3 rule 3 requires for every response, followed by LF, and then closes the connection. A number `id` is written as a plain integer literal (a hello with `id` `1e2` is answered with `"id":100`); a string `id` is written as a JSON string with the same value.

`AUTH_FAILED`:

```text
{"jsonrpc":"2.0","id":<id>,"error":{"code":-32001,"message":"AUTH_FAILED","data":{"kind":"AUTH_FAILED","retryable":false,"detail":"authentication failed","executed":false}}}
```

`PROTOCOL_MISMATCH`:

```text
{"jsonrpc":"2.0","id":<id>,"error":{"code":-32002,"message":"PROTOCOL_MISMATCH","data":{"kind":"PROTOCOL_MISMATCH","retryable":false,"detail":"unsupported protocol major version","executed":false}}}
```

The supported majors are in the discovery file (`protocolMajors`), so the response does not repeat them.
