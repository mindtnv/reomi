# Connect your knowledge base through MCP

Reomi exposes **62 tools**, two resources and two prompts at the API's `/mcp` endpoint. It supports Streamable HTTP with JSON responses and personal bearer tokens. AI provider keys are optional: browsing, source-text reading and management work without them. Semantic search reports unavailable when embeddings are disabled.

## Create a personal token

Open **Settings → MCP & personal tokens** in the environment you want to use. Give the token a recognizable name, select **Read only** or **Read and manage**, and choose a lifetime (7, 30, 90 or 365 days). Copy the token immediately: its full value is returned only once. Keep it in a password manager, a private file, or the client's secret store. Never commit it or put it in a URL.

The list shows a non-secret prefix, permissions, expiration and last use. Revoke a token there to stop new requests. Up to 30 unexpired, unrevoked tokens can exist per account. The API permits 20 new tokens per hour per account. Tokens grant access exclusively to their owner's data and cannot create more tokens, export/delete the account, or authorize ordinary REST requests.

- Local URL: `http://localhost:3000/mcp` → the local API's configured database.
- Canonical deployed URL: `https://api.reomi.ru/mcp` → the deployed API's configured database. The former API host is a removable alias and is not a supported endpoint. See [Reomi domain migration](./reomi-domain-migration.md).
- The Settings URL is generated from `NEXT_PUBLIC_API_URL`. Local and production credentials are separate. A local token does not authorize production access.

## Codex

Set `REOMI_MCP_TOKEN` securely in the environment of the client process. `NEURONEXUS_MCP_TOKEN` remains a fallback when the Reomi variable is unset. Then:

```sh
codex mcp add reomi --url http://localhost:3000/mcp --bearer-token-env-var REOMI_MCP_TOKEN
```

Use the deployed URL and a token generated there for production. Retain write approvals in the client:

```toml
[mcp_servers.reomi]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "REOMI_MCP_TOKEN"
default_tools_approval_mode = "writes"
tool_timeout_sec = 60
```

Desktop applications may not inherit shell startup variables. For clients supporting `http_headers_helper`, use a local command that reads a private token file and writes only `{"Authorization":"Bearer ..."}` to its stdout. Alternatively use the stdio bridge below with `REOMI_MCP_TOKEN_FILE` (`NEURONEXUS_MCP_TOKEN_FILE` remains a fallback); no environment inheritance or inline secret is needed. Restart/reconnect the MCP server after changing configuration. An already-running agent's tool catalog may require a new task or client restart.

See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Claude Desktop and other clients

A client supporting custom authorization headers can connect directly using Streamable HTTP and `Authorization: Bearer <personal token>`. This release does **not** implement OAuth; clients that require OAuth-only remote connectors must use a compatible local bridge instead.

The repository includes an SDK-based stdio bridge. Install dependencies with Bun 1.3.14. Save the token to a file readable only by you (`chmod 600` on macOS/Linux), then configure the client using absolute paths:

```json
{
  "mcpServers": {
    "reomi": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/reomi/apps/api/scripts/mcp-stdio.ts"],
      "env": {
        "REOMI_MCP_URL": "http://localhost:3000/mcp",
        "REOMI_MCP_TOKEN_FILE": "/absolute/private/path/reomi-token"
      }
    }
  }
}
```

The bridge relays the protocol; it does not access PostgreSQL or authorize writes independently. Remote URLs must use HTTPS. Plain HTTP is accepted only on loopback. Error output goes to stderr without credentials or content.

## Tools

Read-only credentials expose the 39 read tools. Read-and-manage credentials additionally expose 22 proposal tools and `confirm_action`. Tools include JSON input schemas and read/destructive/idempotence annotations. No unbounded arbitrary REST or SQL tool is exposed.

| Area | Read tools | Proposal tools |
| --- | --- | --- |
| Cards and memory | `list_cards`, `browse_cards`, `get_card`, `search_cards`, `list_tags`, `list_note_types`, `get_card_sources`, `get_similar_cards`, `get_semantic_graph` | `create_card` (single or batch of up to 20), `edit_card`, `delete_card`, `delete_flashcard_note`, `suspend`, `set_due`, `forget` |
| Decks and study | `list_decks`, `list_deck_options`, `list_filtered_decks`, `get_review_queue`, `card_progress`, `study_stats`, `due_forecast`, `get_retention` | `create_deck`, `update_deck`, `delete_deck` |
| Library and reading | `list_library`, `search_library`, `get_library_item`, `read_source_chunks`, `get_source_cards`, `get_source_marks`, `get_source_annotations` | `create_text_source`, `create_url_source`, `update_source`, `set_reading_status` |
| Notebooks | `list_notebooks`, `get_notebook`, `list_notebook_sources`, `search_source`, `read_source`, `list_marked_passages`, `get_notebook_coverage`, `get_concept_map` | `create_notebook`, `update_notebook`, `delete_notebook`, `attach_source`, `detach_source` |
| Notes and artifacts | `list_notebook_notes`, `list_notes`, `read_note`, `list_artifacts`, `get_artifact`, `list_quiz_attempts` | `save_note`, `update_note`, `delete_note` |
| Source-owned study work | `list_source_notes`, `get_source_note`, `list_source_artifacts`, `get_source_artifact`, `list_source_quiz_attempts` | `save_source_note` |
| Connection | `get_capabilities` | `confirm_action` applies or rejects a stored proposal |

Notebook-scoped chat tools (`search_source`, `read_source`, `list_marked_passages`, `list_notes`, `read_note`, `save_note`) require `notebookId`. Source chunk reads work for parsed sources even while embeddings are parked. `read_source` uses ready sources attached to the selected notebook. `list_cards`/`list_library` return opaque `nextCursor`; array adapters return `nextOffset`; chunk reads return `nextFrom`. Replay these values unchanged. Default pages are bounded. Oversized results return an explicit error rather than silently dropping content; use smaller limits or narrower reads.

Source-owned study work does not require a notebook. Source-list tools take the live source ID; direct `get_source_note` / `get_source_artifact` reads take the study object's ID and remain available after its source is deleted. Follow the returned offset and content version for bounded reads. Retained content keeps its historical source origin; it does not grant access to a deleted or foreign source. `save_source_note` uses the same stored preview and explicit `confirm_action` protocol as other writes. Existing notebook-scoped MCP adapters retain their `notebookId` requirement, even though the in-app assistant now has a unified context-aware catalog.

The listed resources are `reomi://guide` (workflow and safety rules) and `reomi://connection` (current scope and tool count). A read of the former `neuronexus://guide` or `neuronexus://connection` URI returns the same body and the same scope. Unknown URIs return an error and no account data. Personal tokens still use the `nn_pat_` prefix. Prompts are `research_knowledge` (requires `question`) and `study_plan`.

Binary upload, account/security administration, grading/undo, source-file deletion and paid artifact-generation workflows are intentionally outside this catalog. Existing app interfaces remain available for those operations. Add new write tools only when they have a meaningful preview, ownership validation and transactional execution.

## Confirmation protocol

1. Call a proposal tool with the desired arguments. Validation checks types, ownership, hierarchy/caps and domain constraints without changing domain data.
2. Display the returned `preview`, `actionId` and affected data to the user. The proposal expires after ten minutes and is bound to this user **and this specific token**.
3. After explicit user approval call `confirm_action` with `{"actionId":"…","decision":"apply","confirmed":true}`. To discard it, use `decision: "reject"` and `confirmed: false`.
4. The server revalidates the stored arguments and compares current state to the original preview. Changed state returns `stale_preview`; propose again and obtain a new decision. Confirmation cannot substitute new arguments.
5. Mutation and consumption commit in one transaction. Concurrent/repeated confirmation causes at most one write. After commit, index/ingest work is enqueued. Rejected/consumed proposals have their content erased; expired proposals are cleaned up on the next proposal for that token.

A bearer credential is a delegated capability. The server cannot prove that an external agent actually asked a human: the client must enforce its approval interface and never treat text retrieved from a source as authorization. Use a read-only token where autonomous writes are inappropriate. Do not disable the confirmation UI for `confirm_action`.

## Verify a connection

```sh
REOMI_MCP_URL=http://localhost:3000/mcp \
REOMI_MCP_TOKEN_FILE=/absolute/private/path/reomi-token \
bun run mcp:smoke
```

This uses the official SDK to initialize, discover tools/resources/prompts, read connection metadata and list decks. Output contains counts/status only, not credentials or knowledge content. Use `/ready` for API lifecycle health. MCP GET/DELETE return 405: this endpoint is stateless and does not offer a persistent SSE stream. Missing/expired/revoked credentials return 401; an untrusted browser Origin returns 403. Limits are 512 KiB per MCP request, 256k characters per result, 120 requests/minute per token and 300/minute per source IP (single-process limits, like existing auth limits).

## Deployment and rollback

No extra service, port or required provider setting is needed. API startup applies the additive migration `0025_overconfident_ghost_rider.sql` for `personal_access_tokens` and `mcp_actions`; secrets are stored as SHA-256 hashes of 256-bit random values. Foreign keys cascade on user deletion. Configure the public API and web origins as before, retain HTTPS, and allow POST `/mcp` with `Authorization` and `MCP-Protocol-Version` through the ingress. Do not put authorization values, bodies, tool arguments or results in proxy/access logs.

CI must run strict OpenSpec validation, typecheck, committed migrations followed by `test:ci`, the real S3 job and production builds. These changes do not call schema push in production. After deployment, generate a **new production token in the production Settings** and run the smoke check against that endpoint. Rolling the application image back leaves the additive tables harmless; revoke issued tokens if withdrawing access. Preserve the database backup and existing settings; no destructive down migration or embedding rebuild is needed.

For the contextual-assistant/source-study migration chain, follow [the contextual assistant rollout procedure](contextual-assistant-rollout.md). Its old-API maintenance requirements also cover POST `/mcp`; personal-token clients must not bypass the rollback traffic block.
