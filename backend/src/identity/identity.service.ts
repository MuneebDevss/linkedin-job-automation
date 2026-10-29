import {Injectable} from '@nestjs/common';
import {createHash} from 'node:crypto';

@Injectable()
export class IdentityService {
  /**
   * **Summary:** Creates a stable application identity from the strongest available LinkedIn signal while also fingerprinting its content.
   * **Inputs:** `url` is the source post; `text` is its content; `links` contains discovered destinations.
   * **Returns:** The stable application ID, content hash, and identity source used.
   */
  create(url: string | null, text: string, links: string[]): {applicationId: string; contentHash: string; source: string} {
    const content = this.canonicalContent(text, links);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const activity = this.activityId(url || '');
    if (activity) return {applicationId: `linkedin:activity:${activity}`, contentHash, source: 'activity_urn'};

    const permalink = this.canonicalPermalink(url || '');
    if (permalink) {
      const hash = createHash('sha256').update(permalink).digest('hex').slice(0, 32);
      return {applicationId: `linkedin:permalink:${hash}`, contentHash, source: 'permalink'};
    }
    return {applicationId: `content:${contentHash}`, contentHash, source: 'content_hash'};
  }

  /**
   * **Summary:** Creates a deterministic identity for one application-delivery channel so repeated processing remains idempotent.
   * **Inputs:** `applicationId` identifies the captured opportunity; `type` selects email or form delivery.
   * **Returns:** The stable workflow identifier.
   */
  workflowId(applicationId: string, type: 'email' | 'form'): string {
    return createHash('sha256').update(`workflow-v1|${applicationId}|${type}`).digest('hex');
  }

  /**
   * **Summary:** Extracts LinkedIn's canonical activity identifier from supported activity and post URL formats.
   * **Inputs:** `value` is a LinkedIn post or activity URL.
   * **Returns:** The activity ID, or `null` when the URL does not expose one.
   */
  private activityId(value: string): string | null {
    const decoded = decodeURIComponent(value);
    return decoded.match(/urn:li:activity:(\d+)/i)?.[1] ||
      decoded.match(/\/posts\/[^?#/]*-(\d{12,})(?:-|\/|$)/i)?.[1] || null;
  }

  /**
   * **Summary:** Normalizes a supported LinkedIn post permalink for stable identity generation without tracking state.
   * **Inputs:** `value` is the candidate source URL.
   * **Returns:** The canonical LinkedIn permalink, or `null` when unsupported or invalid.
   */
  private canonicalPermalink(value: string): string | null {
    try {
      const url = new URL(value);
      if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !/(?:\/feed\/update\/|\/posts\/|\/pulse\/)/i.test(url.pathname)) return null;
      url.hash = '';
      url.search = '';
      url.hostname = 'www.linkedin.com';
      url.pathname = url.pathname.replace(/\/+$/, '/');
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * **Summary:** Produces a stable representation of post text and application destinations for duplicate detection.
   * **Inputs:** `text` is the captured post content; `links` contains its discovered destinations.
   * **Returns:** The normalized canonical content string.
   */
  private canonicalContent(text: string, links: string[]): string {
    const normalizedText = text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/#[\p{L}\p{N}_]+/gu, ' ')
      .replace(/[^\p{L}\p{N}@.+#]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const destinations = [...new Set(links.map(link => link.toLowerCase().replace(/\/$/, '')))].sort();
    return `${normalizedText}|${destinations.join('|')}`;
  }
}
