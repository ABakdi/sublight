/** Media upload / resolve / relay DTOs (Spec 03 §2, Spec 06 §4.1). */

export interface UploadResult {
  mediaHash: string // "sha256:…"
  durationMs: number
  normalizedBytes: number
}

export type MediaResolveKind = 'relay' | 'direct-url'

export interface MediaResolveRequest {
  url: string
  site?: string
}

export interface MediaResolveResponse {
  mediaId: string
  durationMs: number | null
  title: string | null
  kind: MediaResolveKind
  directUrl?: string
}

export interface RelayMeta {
  mediaId: string
  sizeBytes: number | null
  ready: boolean
  contentType?: string
}
