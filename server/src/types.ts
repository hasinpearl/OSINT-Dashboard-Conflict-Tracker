export interface Item {
  id: number;
  source: string;
  external_id: string;
  conflict?: string;
  panel?: string;
  author?: string;
  title?: string;
  url?: string;
  content: string;
  severity?: string;
  confidence?: string;
  published_at?: Date;
  ingested_at: Date;
  raw: any;
  story_id?: number;
  noise: boolean;
  source_uid?: string;
  lang?: string;
  has_media: boolean;
  event_type?: string;
  is_breaking: boolean;
  primary_location?: any;
  enrichment?: any;
}

export interface SourceStatus {
  id: string;
  source: string;
  label?: string;
  ok: boolean;
  detail?: string;
  failures: number;
  last_ok?: Date;
  updated_at: Date;
}