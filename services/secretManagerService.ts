import { createSign } from 'crypto';
import fs from 'fs/promises';

import { loggerService } from './loggerService.ts';

const API_BASE_URL = 'https://secretmanager.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

interface ListSecretsOptions {
    projectId?: string;
    pageSize?: number;
    pageToken?: string;
}

interface ServiceAccountKey {
    client_email?: string;
    private_key?: string;
    token_uri?: string;
    project_id?: string;
}

interface CachedToken {
    accessToken: string;
    expiry: number;
}

let cachedServiceAccount: ServiceAccountKey | null = null;
let cachedToken: CachedToken | null = null;

const getCredentialsPath = () =>
    process.env.SECRET_MANAGER_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

const base64UrlEncode = (input: string) =>
    Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

async function loadServiceAccount(): Promise<ServiceAccountKey> {
    if (cachedServiceAccount) return cachedServiceAccount;

    const credentialsPath = getCredentialsPath();
    if (!credentialsPath) {
        throw new Error(
            'Missing GOOGLE_APPLICATION_CREDENTIALS or SECRET_MANAGER_SERVICE_ACCOUNT_JSON environment variable for Secret Manager access.'
        );
    }

    let fileContents: string;
    try {
        fileContents = await fs.readFile(credentialsPath, 'utf-8');
    } catch (error) {
        loggerService.error('SecretManagerService: Failed to read service account key file', { error, credentialsPath });
        throw new Error(`Unable to read service account key file at ${credentialsPath}`);
    }

    let parsed: ServiceAccountKey;
    try {
        parsed = JSON.parse(fileContents);
    } catch (error) {
        loggerService.error('SecretManagerService: Service account key file is not valid JSON', { error });
        throw new Error('Service account key file is not valid JSON.');
    }

    if (!parsed.client_email || !parsed.private_key) {
        throw new Error('Service account key file must include client_email and private_key fields.');
    }

    cachedServiceAccount = parsed;
    return parsed;
}

async function resolveProjectId(override?: string) {
    if (override?.trim()) return override.trim();
    const envProject = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    if (envProject?.trim()) return envProject.trim();

    const credentials = await loadServiceAccount();
    return credentials.project_id || '';
}

function createSignedJwt(credentials: ServiceAccountKey) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: credentials.client_email,
        sub: credentials.client_email,
        aud: credentials.token_uri || TOKEN_URL,
        scope: DEFAULT_SCOPE,
        iat: issuedAt,
        exp: issuedAt + 3600
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));

    const signer = createSign('RSA-SHA256');
    signer.update(`${encodedHeader}.${encodedPayload}`);
    signer.end();
    const signature = signer.sign(credentials.private_key as string, 'base64');

    const encodedSignature = signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && cachedToken.expiry - 60000 > now) {
        return cachedToken.accessToken;
    }

    const credentials = await loadServiceAccount();
    const assertion = createSignedJwt(credentials);

    const params = new URLSearchParams();
    params.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    params.set('assertion', assertion);

    const tokenUrl = credentials.token_uri || TOKEN_URL;
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    const bodyText = await response.text();
    if (!response.ok) {
        loggerService.error('SecretManagerService: Failed to fetch access token', {
            status: response.status,
            body_preview: bodyText.slice(0, 200)
        });
        throw new Error(`Failed to obtain access token for Secret Manager (status ${response.status}).`);
    }

    let json: any;
    try {
        json = JSON.parse(bodyText);
    } catch (error) {
        loggerService.error('SecretManagerService: Failed to parse access token response JSON', { error });
        throw new Error('Access token response returned invalid JSON.');
    }

    const accessToken = json.access_token;
    if (!accessToken) {
        throw new Error('Access token missing from OAuth response.');
    }

    const expiresInMs = Math.max(0, Number(json.expires_in || 3600) * 1000);
    cachedToken = {
        accessToken,
        expiry: now + expiresInMs
    };

    return accessToken;
}

const buildHeaders = (accessToken: string) => ({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`
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
    const accessToken = await getAccessToken();

    const projectId = await resolveProjectId(options.projectId);
    if (!projectId) {
        throw new Error(
            'Missing project id for Secret Manager. Set GCP_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or include project_id in the service account key.'
        );
    }

    const url = new URL(`${API_BASE_URL}/projects/${projectId}/secrets`);

    if (options.pageSize && Number.isFinite(options.pageSize)) {
        const size = Math.max(1, Math.min(250, Math.floor(options.pageSize)));
        url.searchParams.set('pageSize', String(size));
    }

    if (options.pageToken) {
        url.searchParams.set('pageToken', options.pageToken);
    }

    const response = await fetch(url, { headers: buildHeaders(accessToken) });
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
    const accessToken = await getAccessToken();

    const projectId = await resolveProjectId(projectIdOverride);
    if (!projectId) {
        throw new Error(
            'Missing project id for Secret Manager. Set GCP_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or include project_id in the service account key.'
        );
    }

    const safeVersion = version?.trim() || 'latest';
    const encodedSecretId = encodeURIComponent(secretId);
    const encodedVersion = encodeURIComponent(safeVersion);

    const url = new URL(
        `${API_BASE_URL}/projects/${projectId}/secrets/${encodedSecretId}/versions/${encodedVersion}:access`
    );

    const response = await fetch(url, { headers: buildHeaders(accessToken) });
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

function setServiceAccountKey(key: ServiceAccountKey) {
    if (!key.client_email || !key.private_key) {
        throw new Error('Service account key must include client_email and private_key fields.');
    }
    cachedServiceAccount = key;
    cachedToken = null; // Clear cached token to force refresh with new credentials
    loggerService.info('SecretManagerService: Service account key updated programmatically.');
}

async function storeSecret(secretId: string, value: string, projectIdOverride?: string) {
    const accessToken = await getAccessToken();
    const projectId = await resolveProjectId(projectIdOverride);
    
    if (!projectId) {
        throw new Error('Missing project id for Secret Manager.');
    }

    const encodedSecretId = encodeURIComponent(secretId);

    // 1. Check if secret exists (by trying to get it)
    const getUrl = new URL(`${API_BASE_URL}/projects/${projectId}/secrets/${encodedSecretId}`);
    const getResponse = await fetch(getUrl, { headers: buildHeaders(accessToken) });

    if (getResponse.status === 404) {
        // 2. Create secret if it doesn't exist
        loggerService.info(`SecretManagerService: Secret ${secretId} not found, creating new secret.`);
        const createUrl = new URL(`${API_BASE_URL}/projects/${projectId}/secrets`);
        createUrl.searchParams.set('secretId', secretId);

        const createBody = {
            replication: {
                automatic: {}
            }
        };

        const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: {
                ...buildHeaders(accessToken),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(createBody)
        });

        if (!createResponse.ok) {
            const errorText = await createResponse.text();
            loggerService.error('SecretManagerService: Failed to create secret', { status: createResponse.status, body: errorText });
            throw new Error(`Failed to create secret ${secretId}: ${createResponse.statusText}`);
        }
    } else if (!getResponse.ok) {
        // Handle other errors
        const errorText = await getResponse.text();
        loggerService.error('SecretManagerService: Failed to check secret existence', { status: getResponse.status, body: errorText });
        throw new Error(`Failed to access secret ${secretId}: ${getResponse.statusText}`);
    }

    // 3. Add new version
    const addVersionUrl = new URL(`${API_BASE_URL}/projects/${projectId}/secrets/${encodedSecretId}:addVersion`);
    const payload = base64UrlEncode(value).replace(/-/g, '+').replace(/_/g, '/'); // Google expects standard Base64 here, not URL-safe? 
    // Actually, API documentation says "data": string (byte). JSON strings are usually base64. 
    // The base64UrlEncode helper creates URL-safe base64. Standard base64 is safer for the API if it doesn't specify URL-safe.
    // Let's use standard Buffer base64.
    
    const standardBase64 = Buffer.from(value).toString('base64');

    const versionBody = {
        payload: {
            data: standardBase64
        }
    };

    const versionResponse = await fetch(addVersionUrl, {
        method: 'POST',
        headers: {
            ...buildHeaders(accessToken),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(versionBody)
    });

    const bodyText = await versionResponse.text();

    if (!versionResponse.ok) {
        loggerService.error('SecretManagerService: Failed to add secret version', { status: versionResponse.status, body: bodyText });
        throw new Error(`Failed to add version to secret ${secretId}: ${versionResponse.statusText}`);
    }

    let json: any;
    try {
        json = JSON.parse(bodyText);
    } catch (error) {
         throw new Error('Secret Manager addVersion returned invalid JSON');
    }

    return {
        project_id: projectId,
        secret_id: secretId,
        version: parseSecretName(json.name).id, // extract version id from full name
        create_time: json.createTime
    };
}

export const secretManagerService = {
    listSecrets,
    accessSecretVersion,
    setServiceAccountKey,
    storeSecret
};
