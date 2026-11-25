/**
 * 只读目录 API - 供 AI 客户端发现和列出图片
 * 
 * 端点: GET /api/catalog/list
 * 认证: Authorization: Bearer <catalog_token>
 * 
 * 查询参数:
 * - dir: 目录路径 (可选，默认根目录)
 * - search: 搜索关键字 (可选)
 * - type: 文件类型过滤 image|video|audio|other (可选)
 * - start: 分页起始位置 (可选，默认 0)
 * - count: 返回数量 (可选，默认 50，最大 200)
 * - recursive: 是否递归子目录 (可选，默认 false)
 * 
 * 响应: { files: [...], directories: [...], totalCount, returnedCount, hasMore }
 * 
 * 安全:
 * - 仅返回公开可访问的文件（已过滤屏蔽/成人/已删除内容）
 * - 仅返回安全元数据（名称、路径、大小、类型、标签）
 * - 返回公共访问 URL（非内部存储地址）
 * - 永不暴露：TG file_id/token、存储凭据、内部配置、原始存储地址
 */

import { readIndex } from '../../utils/indexManager.js';
import { getFileTypeCategory } from '../../utils/mimeTypes.js';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/**
 * 从文件记录中提取安全元数据（白名单方式）
 * @param {Object} file - 文件记录
 * @param {string} origin - 请求来源域名
 * @returns {Object} 安全的文件信息
 */
function extractSafeFileInfo(file, origin) {
    const metadata = file.metadata || {};
    const fileId = file.id || file.name;

    const safeInfo = {
        name: metadata.FileName || extractFileName(fileId),
        path: fileId,
        url: `${origin}/file/${encodeURIComponent(fileId)}`,
    };

    if (metadata.FileType) {
        safeInfo.type = metadata.FileType;
    }
    if (metadata.FileSize !== undefined && metadata.FileSize !== null) {
        safeInfo.size = parseFloat(metadata.FileSize);
    }
    if (metadata.TimeStamp) {
        safeInfo.timestamp = metadata.TimeStamp;
    }
    if (Array.isArray(metadata.Tags) && metadata.Tags.length > 0) {
        safeInfo.tags = metadata.Tags;
    }
    if (metadata.Directory) {
        safeInfo.directory = metadata.Directory;
    }

    return safeInfo;
}

function extractFileName(fileId) {
    const lastSlash = fileId.lastIndexOf('/');
    return lastSlash >= 0 ? fileId.substring(lastSlash + 1) : fileId;
}

function sanitizeDirectory(dir) {
    if (!dir) return '';
    return dir.replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (request.method === 'HEAD') {
        return new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
    }

    try {
        let dir = sanitizeDirectory(url.searchParams.get('dir') || '');
        const search = (url.searchParams.get('search') || '').trim();
        const fileType = url.searchParams.get('type') || '';
        const recursive = url.searchParams.get('recursive') === 'true';

        let start = parseInt(url.searchParams.get('start'), 10) || 0;
        let count = parseInt(url.searchParams.get('count'), 10) || DEFAULT_PAGE_SIZE;

        start = Math.max(0, start);
        count = Math.min(Math.max(1, count), MAX_PAGE_SIZE);

        if (dir && !dir.endsWith('/')) {
            dir += '/';
        }

        const fileTypeArr = fileType ? [fileType] : [];

        const result = await readIndex(context, {
            search,
            directory: dir,
            start,
            count,
            fileType: fileTypeArr,
            accessStatus: ['normal'],
            includeSubdirFiles: recursive,
        });

        if (!result.success) {
            return new Response(JSON.stringify({
                error: 'Failed to read file index',
                files: [],
                directories: [],
                totalCount: 0,
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
        }

        const origin = url.origin;
        const safeFiles = result.files.map(file => extractSafeFileInfo(file, origin));

        const response = {
            files: safeFiles,
            directories: result.directories || [],
            totalCount: result.totalCount,
            returnedCount: safeFiles.length,
            hasMore: (start + safeFiles.length) < result.totalCount,
        };

        if (search) {
            response.search = search;
        }
        if (dir) {
            response.directory = dir;
        }

        return new Response(JSON.stringify(response), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'private, max-age=60',
                ...CORS_HEADERS,
            },
        });

    } catch (error) {
        console.error('Catalog API error:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
    }
}
