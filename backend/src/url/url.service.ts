import {BadRequestException, Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {AppConfiguration} from '../config/app.config';

const TRACKING_PARAMS = /^(utm_[^=]*|trk|trackingid|fbclid|gclid)$/i;

@Injectable()
export class UrlService {
  private readonly logger = new Logger(UrlService.name);

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  normalize(value: string, base?: string): string | null {
    let candidate = String(value || '').trim().replace(/^[<(\[{"']+/, '').replace(/[>\])}"',;:.!?]+$/, '');
    if (!candidate) return null;
    if (/^www\./i.test(candidate)) candidate = `https://${candidate}`;
    if (/^mailto:/i.test(candidate)) {
      const address = candidate.slice(7).split('?')[0].toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? `mailto:${address}` : null;
    }
    try {
      const url = base ? new URL(candidate, base) : new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
      return url.href;
    } catch {
      return null;
    }
  }

  extractTextUrls(text: string): string[] {
    return text.match(/(?:https?:\/\/|www\.)[^\s<>"'`]+/gi) || [];
  }

  async normalizeAndResolve(values: string[]): Promise<string[]> {
    const normalized = (await Promise.all(values.map(value => this.unwrapLinkedInRedirect(value))))
      .filter((value): value is string => Boolean(value));
    const resolved = await Promise.all(normalized.map(value => this.isLinkedInShortUrl(value) ? this.resolveShortUrl(value) : value));
    return [...new Map(resolved.map(value => [value.replace(/\/$/, ''), value])).values()];
  }

  private async unwrapLinkedInRedirect(value: string): Promise<string | null> {
    const normalized = this.normalize(value);
    if (!normalized || normalized.startsWith('mailto:')) return normalized;
    const url = new URL(normalized);
    if (/(^|\.)linkedin\.com$/i.test(url.hostname) && /(?:\/redir\/redirect|\/safety\/go)/.test(url.pathname)) {
      const destination = this.normalize(url.searchParams.get('url') || '');
      if (!destination) return normalized;
      try {
        await this.assertPublicDestination(new URL(destination));
        return destination;
      } catch {
        return normalized;
      }
    }
    return normalized;
  }

  private isLinkedInShortUrl(value: string): boolean {
    try {
      return new URL(value).hostname.toLowerCase() === 'lnkd.in';
    } catch {
      return false;
    }
  }

  private async resolveShortUrl(original: string): Promise<string> {
    const source = new URL(original);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.get('urlResolutionTimeoutMs', {infer: true}));
    try {
      let current = source;
      for (let hop = 0; hop < 5; hop += 1) {
        await this.assertPublicDestination(current);
        const response = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          headers: {'user-agent': 'JobPostN8n/0.1 (+local resolver)', accept: 'text/html'},
          signal: controller.signal
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          const destination = location ? this.normalize(location, current.href) : null;
          if (!destination) return original;
          const unwrapped = await this.unwrapLinkedInRedirect(destination);
          if (!unwrapped) return original;
          await this.assertPublicDestination(new URL(unwrapped));
          if (unwrapped !== destination || !this.isLinkedInResolverUrl(unwrapped)) return unwrapped;
          current = new URL(unwrapped);
          continue;
        }
        if (!response.ok) return original;
        const length = Number(response.headers.get('content-length') || 0);
        if (length > 262144) return original;
        const html = (await response.text()).slice(0, 262145);
        if (html.length > 262144) return original;
        const destination = this.externalLinkFromInterstitial(html);
        if (!destination) return original;
        await this.assertPublicDestination(new URL(destination));
        return destination;
      }
      return original;
    } catch (error) {
      this.logger.warn(`Short URL resolution failed for ${source.hostname}: ${error instanceof Error ? error.message : String(error)}`);
      return original;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isLinkedInResolverUrl(value: string): boolean {
    const url = new URL(value);
    return url.hostname.toLowerCase() === 'lnkd.in' ||
      (/(^|\.)linkedin\.com$/i.test(url.hostname) && /(?:\/redir\/redirect|\/safety\/go)/.test(url.pathname));
  }

  private externalLinkFromInterstitial(html: string): string | null {
    const tags = html.match(/<a\b[^>]*>/gi) || [];
    const tag = tags.find(value => /data-tracking-control-name\s*=\s*["']external_url_click["']/i.test(value));
    const href = tag?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]
      ?.replace(/&amp;/gi, '&').replace(/&#x2F;/gi, '/');
    const normalized = this.normalize(href || '');
    return normalized?.startsWith('https://') ? normalized : null;
  }

  private async assertPublicDestination(url: URL): Promise<void> {
    if (url.protocol !== 'https:' || url.username || url.password) throw new BadRequestException('Only credential-free HTTPS URLs can be resolved.');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new BadRequestException('Network-local URL destinations are not allowed.');
    }
    const addresses = isIP(host) ? [{address: host, family: isIP(host)}] : await lookup(host, {all: true, verbatim: true});
    if (!addresses.length || addresses.some(({address}) => this.isPrivateAddress(address))) {
      throw new BadRequestException('Private or unresolved URL destinations are not allowed.');
    }
  }

  private isPrivateAddress(address: string): boolean {
    const normalized = address.toLowerCase();
    if (normalized.includes(':')) {
      // Reject unspecified/loopback, IPv4-compatible/mapped, unique-local,
      // and link-local IPv6 destinations. Public IPv6 addresses never begin
      // with the compressed all-zero prefix used by mapped addresses.
      return normalized === '::1' || normalized === '::' || normalized.startsWith('::') ||
        normalized.startsWith('fc') || normalized.startsWith('fd') ||
        /^fe[89ab]/.test(normalized) || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') ||
        normalized.startsWith('::ffff:192.168.') || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized);
    }
    const parts = normalized.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
      (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 192 && parts[1] === 0) || (parts[0] === 198 && [18, 19].includes(parts[1])) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
  }
}
