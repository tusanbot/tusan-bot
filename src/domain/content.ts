export type SourceTable =
  | "news_announcements"
  | "blog_posts"
  | "services_announcements";

export type ContentKind = "news" | "article" | "registration";

export interface NormalizedContent {
  sourceTable: SourceTable;
  sourceId: string;
  kind: ContentKind;
  title: string;
  summary: string;
  content: string;
  publicUrl: string;
  updatedAt: string;
  createdAt: string;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  requestUrl: string | null;
  buttonLabel: string | null;
}

export type PublicationOperation = "publish" | "edit" | "expire" | "remove";
