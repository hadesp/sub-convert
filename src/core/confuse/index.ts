import type { ClashType, SingboxType, V2RayType, VpsMap } from '../../types';
import { HTTPException } from 'hono/http-exception';
import { DEFAULT_CONFIG } from '../../config';
import { getUrlGroup } from '../../shared';
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
        this.parser = new Parser(vps, [], protocol, exclude);
        this.vps = vps;

        await this.parser.parse(vps);

        const urlGroups = getUrlGroup(Array.from(this.parser.urls), Number(this.chunkCount));

        this.urls = urlGroups.map(urlGroup => {
            const confuseUrl = new URL(`${this.backend}/sub`);
            const { searchParams } = new URL(request.url);
            searchParams.set('url', urlGroup);
            if (!searchParams.get('config')) {
                searchParams.set('config', this.remoteConfig);
            }
            // Legacy Web UI tag arrays are handled locally; native OpenClash
            // include/exclude expressions are passed unchanged to SubConverter.
            if (exclude?.trim().startsWith('[')) {
                try {
                    if (Array.isArray(JSON.parse(exclude))) searchParams.delete('exclude');
                } catch { /* Treat non-JSON values as backend regex expressions. */ }
            }
            confuseUrl.search = searchParams.toString();
            return confuseUrl.toString();
        });
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
}

