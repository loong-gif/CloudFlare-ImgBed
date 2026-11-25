/**
 * Catalog API 认证中间件
 * 仅允许具有 'catalog' 权限的 Bearer Token 访问
 * 拒绝所有修改操作（仅允许 GET/HEAD/OPTIONS）
 */

import { getDatabase } from '../../utils/databaseAdapter.js';
import { validateCatalogToken } from '../../utils/auth/catalogTokenValidator.js';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

function UnauthorizedException(reason) {
    return new Response(JSON.stringify({ error: reason }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...CORS_HEADERS,
        },
    });
}

function MethodNotAllowed() {
    return new Response(JSON.stringify({ error: 'Method not allowed. This is a read-only API.' }), {
        status: 405,
        headers: {
            'Content-Type': 'application/json',
            'Allow': 'GET, HEAD, OPTIONS',
            ...CORS_HEADERS,
        },
    });
}

async function authentication(context) {
    const { request, env } = context;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method !== 'GET' && method !== 'HEAD') {
        return MethodNotAllowed();
    }

    const db = getDatabase(env);
    const result = await validateCatalogToken(request, db);

    if (!result.valid) {
        return UnauthorizedException(result.error || 'Invalid or missing catalog token');
    }

    return context.next();
}

export const onRequest = [authentication];
