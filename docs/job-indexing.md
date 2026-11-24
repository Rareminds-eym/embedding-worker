# Embedding provider boundary

This worker only generates embeddings for trusted application callers over the existing service-binding RPC interface. It does not connect to application databases, hold database credentials, claim indexing work, or publish job vectors.

The application owns indexing coordination, durable dispatch, database leases, retries, and validated publication. It sends text to `EmbeddingService.embedText` and receives the vector and model metadata. Every named deployed embedding environment uses its own native rate limiter; the KV fallback is local-only.

See [application job indexing](../../sp-dash/docs/job-indexing.md) for deployment, progress, and recovery details.
