# Comfy Cloud API notes (researched 2026-10-24 from docs.comfy.org)

Sources:
- https://docs.comfy.org/development/cloud/api-reference  (v1 "Cloud API", marked DEPRECATED in favor of Comfy API v2, still works)
- https://docs.comfy.org/development/cloud/openapi
- https://docs.comfy.org/openapi-v2.yaml  (copied here as comfy-api-v2.openapi.yaml - READ IT, it is the source of truth)
- API key: generated at https://platform.comfy.org/profile/api-keys . Running workflows via API needs an active Comfy Cloud subscription/credits.

## Comfy API v2 (preferred) - base https://cloud.comfy.org
- Auth: `Authorization: Bearer <api key>` (account-scoped key, starts `comfyui-`).
- POST /api/v2/assets  (multipart upload, returns asset record with UUID id) - upload photos/audio.
- POST /api/v2/jobs  body: { workflow: <API-format graph, verbatim>, extra_data?: {...} } -> 201 job. Optional `Idempotency-Key` header (single-use; on unknown outcome poll/list instead of resubmitting).
  UI-format workflow (nodes/links) is rejected (`workflow_format_ui`). Asset references inside the graph are `core/ASSET` objects whose id must exist and be owned by caller (see spec).
- GET /api/v2/jobs/{id}  poll status + outputs (follow links embedded in responses; don't build URLs).
- GET /api/v2/jobs/{id}/events  SSE live stream (optional enhancement; polling is source of truth).
- GET /api/v2/jobs/{id}/logs, POST /api/v2/jobs/{id}/cancel
- GET /api/v2/assets/{id}/content  download output bytes.

## v1 (deprecated, ComfyUI-compatible) - base https://cloud.comfy.org
- Header `X-API-Key: <key>`.
- POST /api/upload/image (multipart: image, type=input, overwrite=true) -> {name, subfolder}
- POST /api/prompt { prompt: <API-format workflow>, extra_data?: { api_key_comfy_org } } -> { prompt_id }
- GET /api/job/{prompt_id}/status -> { status }. Terminal: success | error | non_retryable_error | lost | cancelled. Everything else is in-flight.
- WS wss://cloud.comfy.org/ws?clientId=<uuid>&token=<key> for executed/output messages.
- GET /api/view?filename=&subfolder=&type=output -> 302 to signed URL. Do NOT follow redirect with the key header; fetch the signed URL with no auth headers.
- Errors: 400 bad workflow, 401 bad key, 402 insufficient credits, 429 subscription inactive.
