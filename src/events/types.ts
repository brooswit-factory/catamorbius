/** CloudEvents 1.0 envelope. See the CloudEvents project's spec, version 1.0.2. */

export interface CloudEventEntity {
  kind: string;
  key: string;
  url?: string;
}

/** Every field optional — an unrecognized event carries an empty summary. */
export interface CloudEventSummary {
  actor?: string;
  action?: string;
  entity?: CloudEventEntity;
  title?: string;
}

export interface CloudEventRaw {
  /** The provider payload parsed as JSON, verbatim — or the raw body string when it does not parse. */
  body: unknown;
  /** Selected delivery headers, lowercase keys. */
  headers: Record<string, string>;
}

export interface CloudEventData {
  raw: CloudEventRaw;
  summary: CloudEventSummary;
}

export interface CloudEvent {
  specversion: "1.0";
  id: string;
  /** URI-reference, convention "//<provider>/<instance>". */
  source: string;
  /** Reverse-DNS, e.g. com.example.pull_request.opened, or "<provider>.unknown". */
  type: string;
  /** RFC 3339 timestamp — the provider's own when it has one, else receipt time. */
  time: string;
  /** The entity key, e.g. KAN-123, owner/repo#42. */
  subject?: string;
  datacontenttype: "application/json";
  data: CloudEventData;
}
