import { HTTPException } from 'hono/http-exception';

export interface SourceProvider {
    name: string;
    definition?: Record<string, any>;
    ids: string[];
}

// SubConverter expressions are evaluated on original names, before marker/type
// decoration. Reject syntax we cannot preserve rather than silently filter nodes.
export function subscriptionRegex(value: string | null): RegExp | null {
    if (!value) return null;
    let flags = '';
    const pattern = value.replace(/^\(\?([ims]+)\)/, (_, modes) => {
        flags = modes;
        return '';
    });
    try {
        return new RegExp(pattern, flags);
    } catch {
        throw new HTTPException(400, { message: 'Unsupported include/exclude regex syntax' });
    }
}

export async function downloadSubscription(url: string, headers?: HeadersInit): Promise<string> {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported subscription scheme');
    const response = await fetch(parsed, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Subscription download failed');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty subscription response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Subscription response too large');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
}

export function isHighMultiplier(name: string): boolean {
    if (/高倍率|高倍/.test(name)) return true;
    const marked = /(?:倍率\s*[:：=]?\s*(\d+(?:\.\d+)?)|(?:^|[^\d.])(\d+(?:\.\d+)?)\s*[xX倍](?![A-Za-z\d])|(?:^|[^A-Za-z\d.])[xX]\s*(\d+(?:\.\d+)?)(?![A-Za-z\d.]))/g;
    for (const match of name.matchAll(marked)) {
        if (Number(match[1] ?? match[2] ?? match[3]) >= 2) return true;
    }
    return false;
}
