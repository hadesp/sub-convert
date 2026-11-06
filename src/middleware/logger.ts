import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from 'src/bindings';

export function loggerMiddleware(): MiddlewareHandler<AppBindings> {
    return async (c, next) => {
        await next();
        console.info(c.req.method, c.req.path, c.res.status);
    };
}
