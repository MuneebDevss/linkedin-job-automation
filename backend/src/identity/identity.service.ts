import {Injectable} from '@nestjs/common';
import {createHash} from 'node:crypto';

@Injectable()
export class IdentityService {
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

  workflowId(applicationId: string, type: 'email' | 'form'): string {
    return createHash('sha256').update(`workflow-v1|${applicationId}|${type}`).digest('hex');
  }

  private activityId(value: string): string | null {
    const decoded = decodeURIComponent(value);
    return decoded.match(/urn:li:activity:(\d+)/i)?.[1] ||
      decoded.match(/\/posts\/[^?#/]*-(\d{12,})(?:-|\/|$)/i)?.[1] || null;
  }

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

  private canonicalContent(text: string, links: string[]): string {
    const normalizedText = text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/#[\p{L}\p{N}_]+/gu, ' ')
      .replace(/[^\p{L}\p{N}@.+#]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const destinations = [...new Set(links.map(link => link.toLowerCase().replace(/\/$/, '')))].sort();
    return `${normalizedText}|${destinations.join('|')}`;
  }
}
