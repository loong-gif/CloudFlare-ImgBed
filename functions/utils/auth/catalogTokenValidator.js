/**
 * Catalog Token 验证器
 * 仅验证具有 'catalog' 权限的只读 API Token
 */
import { getTokenData } from '../../api/manage/apiTokens.js';
import { isExpired } from './tokenExpiration.js';

const CATALOG_PERMISSION = 'catalog';

/**
 * 验证 Catalog API Token
 * @param {Request} request - 请求对象
 * @param {Object} db - 数据库适配器
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function validateCatalogToken(request, db) {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader) {
        return { valid: false, error: 'Missing Authorization header. Use: Authorization: Bearer <token>' };
    }

    let token;
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    } else {
        return { valid: false, error: 'Invalid Authorization format. Use: Authorization: Bearer <token>' };
    }

    if (!token) {
        return { valid: false, error: 'Empty token' };
    }

    const tokenData = await getTokenData(db, token);

    if (!tokenData) {
        return { valid: false, error: 'Invalid token' };
    }

    if (isExpired(tokenData.expiresAt)) {
        return { valid: false, error: 'Token expired' };
    }

    if (!tokenData.permissions.includes(CATALOG_PERMISSION)) {
        return { valid: false, error: `Token lacks '${CATALOG_PERMISSION}' permission` };
    }

    return { valid: true, tokenData };
}
