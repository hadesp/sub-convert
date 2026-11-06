import type { ClashType, SingboxType, V2RayType, VpsMap } from '../../types';
import { HTTPException } from 'hono/http-exception';
import { DEFAULT_CONFIG } from '../../config';
import { Parser } from '../parser';
import { ClashClient } from './client/clash';
import { SingboxClient } from './client/singbox';
import { V2RayClient } from './client/v2ray';

export class Confuse {
    private urls: string[] = [];
    private vps: string[] = [];

    private chunkCount: number = Number(DEFAULT_CONFIG.CHUNK_COUNT);
    private backend: string = DEFAULT_CONFIG.BACKEND;
    private remoteConfig: string;
    private parser: Parser | null = null;

    private clashClient: ClashClient = new ClashClient();
    private singboxClient: SingboxClient = new SingboxClient();
    private v2rayClient: V2RayClient = new V2RayClient(this.vps);

    constructor(env: Env) {
        this.chunkCount = Number(env.CHUNK_COUNT ?? DEFAULT_CONFIG.CHUNK_COUNT);
        this.backend = env.BACKEND ?? DEFAULT_CONFIG.BACKEND;
        this.remoteConfig = env.REMOTE_CONFIG || DEFAULT_CONFIG.REMOTE_CONFIG;
        this.parser = null;
    }

    public async setSubUrls(request: Request): Promise<void> {
        const { searchParams } = new URL(request.url);
        const vpsUrl = searchParams.get('url');
        if (!vpsUrl?.trim()) {
            throw new HTTPException(400, { message: 'Missing subscription url' });
        }
        const protocol = searchParams.get('protocol');
        const exclude = searchParams.get('exclude');
        this.backend = searchParams.get('backend') ?? this.backend;

        const vps = vpsUrl!.split(/\||\n/).filter(Boolean);
        this.parser = new Parser(vps, [], protocol, exclude, searchParams.get('include'), ['clash', 'clashr'].includes(searchParams.get('target') ?? ''));
        this.vps = vps;

        await this.parser.parse(vps);

        const makeUrl = (nodes: string[]) => {
            const confuseUrl = new URL(`${this.backend}/sub`);
            const { searchParams } = new URL(request.url);
            searchParams.set('url', nodes.join('|'));
            // Count and apply filters once on original names, not on UUID markers.
            searchParams.delete('include');
            searchParams.delete('exclude');
            if (!searchParams.get('config')) {
                searchParams.set('config', this.remoteConfig);
            }
            confuseUrl.search = searchParams.toString();
            return confuseUrl.toString();
        };
        // SubConverter frontends may reject request URLs above 8 KiB. Bound
        // actual encoded bytes as well as node count, without dropping nodes.
        this.urls = [];
        let batch: string[] = [];
        const maxNodes = Number.isInteger(this.chunkCount) && this.chunkCount > 0 ? this.chunkCount : 20;
        for (const node of this.parser.urls) {
            const candidate = [...batch, node];
            if (batch.length && (candidate.length > maxNodes || new TextEncoder().encode(makeUrl(candidate)).length > 6500)) {
                this.urls.push(makeUrl(batch));
                batch = [];
            }
            batch.push(node);
            if (new TextEncoder().encode(makeUrl(batch)).length > 6500) throw new HTTPException(422, { message: 'One proxy exceeds backend request URL budget' });
        }
        if (batch.length) this.urls.push(makeUrl(batch));
    }

    public async getClashConfig(): Promise<ClashType> {
        return await this.clashClient.getConfig(this.urls);
    }

    public async getSingboxConfig(): Promise<SingboxType> {
        return await this.singboxClient.getConfig(this.urls);
    }

    public async getV2RayConfig(): Promise<V2RayType> {
        return await this.v2rayClient.getConfig(this.urls, this.vps);
    }

    get vpsStore(): VpsMap | undefined {
        return this.parser?.vpsMap;
    }

    get parserState(): Parser | null { return this.parser; }
}

