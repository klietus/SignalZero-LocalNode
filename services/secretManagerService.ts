import { loggerService } from './loggerService.ts';

const API_BASE_URL = 'https://secretmanager.googleapis.com/v1';

interface ListSecretsOptions {
    projectId?: string;
    pageSize?: number;
    pageToken?: string;
}

const resolveProjectId = (override?: string) => {
    return override?.trim() || process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
};

const getApiKey = () => process.env.API_KEY || '';

const buildHeaders = (apiKey: string) => ({
    'Accept': 'application/json',
    'X-Goog-Api-Key': apiKey
});

const parseSecretName = (fullName?: string) => {
    if (!fullName) return { id: undefined, projectId: undefined };
    const parts = fullName.split('/');
    return {
        projectId: parts.length >= 2 ? parts[1] : undefined,
        id: parts[parts.length - 1]
    };
};

async function listSecrets(options: ListSecretsOptions = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('Missing API_KEY environment variable for Secret Manager access.');
    }

    const projectId = resolveProjectId(options.projectId);
    if (!projectId) {
        throw new Error('Missing project id for Secret Manager. Set GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT.');
    }

    const url = new URL(`${API_BASE_URL}/projects/${projectId}/secrets`);
    url.searchParams.set('key', apiKey);

    if (options.pageSize && Number.isFinite(options.pageSize)) {
        const size = Math.max(1, Math.min(250, Math.floor(options.pageSize)));
        url.searchParams.set('pageSize', String(size));
    }

    if (options.pageToken) {
        url.searchParams.set('pageToken', options.pageToken);
    }

    const response = await fetch(url, { headers: buildHeaders(apiKey) });
    const bodyText = await response.text();

    if (!response.ok) {
        loggerService.error('SecretManagerService: listSecrets failed', {
            status: response.status,
            body_preview: bodyText.slice(0, 200)
        });
        throw new Error(`Secret Manager list failed with status ${response.status}`);
    }

    let json: any;
    try {
        json = JSON.parse(bodyText);
    } catch (error) {
        loggerService.error('SecretManagerService: Failed to parse listSecrets response JSON', { error });
        throw new Error('Secret Manager list returned invalid JSON');
    }

    const secrets = Array.isArray(json.secrets)
        ? json.secrets.map((secret: any) => {
            const parsed = parseSecretName(secret.name);
            return {
                id: parsed.id,
                project_id: parsed.projectId,
                labels: secret.labels,
                create_time: secret.createTime,
                replication: secret.replication,
                topics: secret.topics,
            };
        })
        : [];

    return {
        project_id: projectId,
        count: secrets.length,
        secrets,
        next_page_token: json.nextPageToken
    };
}

async function accessSecretVersion(secretId: string, version: string = 'latest', projectIdOverride?: string) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('Missing API_KEY environment variable for Secret Manager access.');
    }

    const projectId = resolveProjectId(projectIdOverride);
    if (!projectId) {
        throw new Error('Missing project id for Secret Manager. Set GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT.');
    }

    const safeVersion = version?.trim() || 'latest';
    const encodedSecretId = encodeURIComponent(secretId);
    const encodedVersion = encodeURIComponent(safeVersion);

    const url = new URL(
        `${API_BASE_URL}/projects/${projectId}/secrets/${encodedSecretId}/versions/${encodedVersion}:access`
    );
    url.searchParams.set('key', apiKey);

    const response = await fetch(url, { headers: buildHeaders(apiKey) });
    const bodyText = await response.text();

    if (!response.ok) {
        loggerService.error('SecretManagerService: accessSecretVersion failed', {
            status: response.status,
            secretId,
            version: safeVersion,
            body_preview: bodyText.slice(0, 200)
        });
        throw new Error(`Secret Manager access failed with status ${response.status}`);
    }

    let json: any;
    try {
        json = JSON.parse(bodyText);
    } catch (error) {
        loggerService.error('SecretManagerService: Failed to parse accessSecretVersion response JSON', { error });
        throw new Error('Secret Manager access returned invalid JSON');
    }

    const payload = json.payload?.data;
    if (!payload) {
        throw new Error('Secret payload missing from Secret Manager response');
    }

    let decoded: string;
    try {
        decoded = Buffer.from(payload, 'base64').toString('utf-8');
    } catch (error) {
        loggerService.error('SecretManagerService: Failed to decode secret payload', { error });
        throw new Error('Failed to decode secret payload from Secret Manager');
    }

    return {
        project_id: projectId,
        secret_id: secretId,
        version: safeVersion,
        value: decoded
    };
}

export const secretManagerService = {
    listSecrets,
    accessSecretVersion
};
