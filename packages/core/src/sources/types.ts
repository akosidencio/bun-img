/**
 * The source-resolution contract.
 *
 * A resolver turns a source reference from a URL into bytes plus an identity.
 * Everything that reads from the outside world implements this, so the engine
 * has exactly one place where untrusted input becomes an image.
 */
import type { SourceIdentity } from "../types.ts";
import type { ResolvedConfig } from "../config.ts";

export interface ResolvedSource {
  /** The bytes. Already size-capped by the resolver. */
  readonly data: Uint8Array | Blob;
  /**
   * Stable identity for cache keying. `version` must change when the bytes do —
   * an ETag, a Last-Modified, or `mtime:size`. Its absence means the engine
   * cannot detect source changes, so the response must not claim `immutable`.
   */
  readonly identity: SourceIdentity;
  readonly kind: "local" | "remote" | "custom";
  /** Reported by the origin. Advisory only — the decoder has the final say. */
  readonly contentType?: string;
}

export interface ResolveContext {
  readonly config: ResolvedConfig;
  /** Aborts the whole resolution, including the body read. */
  readonly signal?: AbortSignal;
}

export interface SourceResolver {
  readonly name: string;
  /** Cheap syntactic check. Must not perform I/O. */
  supports(source: string): boolean;
  resolve(source: string, context: ResolveContext): Promise<ResolvedSource>;
}
