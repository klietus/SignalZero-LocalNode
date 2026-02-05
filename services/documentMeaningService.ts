import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import Parser from 'rss-parser';
import pdf from 'pdf-parse';
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { loggerService } from './loggerService.js';
import { settingsService } from './settingsService.js';

export interface NormalizedDocument {
    type: 'html' | 'rss' | 'pdf' | 'text' | 'json' | 'image' | 'unknown';
    metadata: {
        title?: string;
        description?: string;
        author?: string;
        publishedDate?: string;
        url?: string;
        [key: string]: any;
    };
    content: string;
    structured_data?: any;
}

class DocumentMeaningService {
    private rssParser: Parser;

    constructor() {
        this.rssParser = new Parser();
    }

    async parse(content: Buffer | string, contentType: string, url?: string): Promise<NormalizedDocument> {
        const type = this.detectType(contentType, url, content);
        
        loggerService.info(`DocumentMeaningService: Detected type ${type} for ${url}`);

        try {
            switch (type) {
                case 'rss':
                    return await this.parseRss(content.toString());
                case 'pdf':
                    // pdf-parse expects a Buffer
                    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
                    return await this.parsePdf(buffer);
                case 'html':
                    return this.parseHtml(content.toString());
                case 'json':
                     return this.parseJson(content.toString());
                case 'image':
                    const imgBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
                    return await this.extractImageMeaning(imgBuffer, contentType, url);
                default:
                    return {
                        type: 'text',
                        metadata: { url },
                        content: content.toString()
                    };
            }
        } catch (error) {
            loggerService.error('DocumentMeaningService: Parsing failed', { type, url, error });
            return {
                type: 'unknown',
                metadata: { url, error: String(error) },
                content: content.toString().slice(0, 1000) // Return raw partial content on failure
            };
        }
    }

    private detectType(contentType: string, url: string | undefined, content: Buffer | string): 'html' | 'rss' | 'pdf' | 'json' | 'image' | 'text' {
        const lowerType = contentType?.toLowerCase() || '';
        const lowerUrl = url?.toLowerCase() || '';
        const contentStr = content.toString();

        if (lowerType.startsWith('image/') || lowerUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
            return 'image';
        }

        if (lowerType.includes('application/rss+xml') || lowerType.includes('application/atom+xml') || lowerType.includes('application/xml') || lowerType.includes('text/xml')) {
            // Further check for RSS content if generic XML
            if (contentStr.includes('<rss') || contentStr.includes('<feed') || contentStr.includes('<channel>')) {
                return 'rss';
            }
        }
        
        if (lowerType.includes('pdf') || lowerUrl.endsWith('.pdf')) {
            return 'pdf';
        }

        if (lowerType.includes('html')) {
            return 'html';
        }

        if (lowerType.includes('json')) {
            return 'json';
        }

        return 'text';
    }

    private async parseRss(content: string): Promise<NormalizedDocument> {
        const feed = await this.rssParser.parseString(content);
        return {
            type: 'rss',
            metadata: {
                title: feed.title,
                description: feed.description,
                url: feed.link,
                language: feed.language
            },
            content: feed.items.map(item => {
                const title = item.title ? `Title: ${item.title}` : '';
                const snippet = item.contentSnippet ? `\nSummary: ${item.contentSnippet}` : '';
                const link = item.link ? `\nLink: ${item.link}` : '';
                return `${title}${snippet}${link}`;
            }).join('\n\n---\n\n'),
            structured_data: feed.items
        };
    }

    private async parsePdf(content: Buffer): Promise<NormalizedDocument> {
        const data = await pdf(content);
        return {
            type: 'pdf',
            metadata: {
                pages: data.numpages,
                info: data.info
            },
            content: data.text
        };
    }

    private parseHtml(content: string): NormalizedDocument {
        const dom = new JSDOM(content);
        const doc = dom.window.document;
        
        // Extract images
        const images: { url: string; title: string }[] = [];
        const imgElements = doc.querySelectorAll('img');
        imgElements.forEach((el) => {
            const src = el.getAttribute('src');
            const alt = el.getAttribute('alt') || el.getAttribute('title') || '';
            if (src) {
                images.push({ url: src, title: alt.trim() });
            }
        });

        // Extract forms
        const forms: any[] = [];
        const formElements = doc.querySelectorAll('form');
        formElements.forEach((form) => {
            const inputs: any[] = [];
            form.querySelectorAll('input, textarea, select').forEach((el: any) => {
                inputs.push({
                    name: el.getAttribute('name'),
                    type: el.tagName.toLowerCase() === 'input' ? el.getAttribute('type') : el.tagName.toLowerCase(),
                    value: el.getAttribute('value'),
                    placeholder: el.getAttribute('placeholder'),
                    required: el.hasAttribute('required')
                });
            });

            forms.push({
                action: form.getAttribute('action'),
                method: form.getAttribute('method') || 'GET',
                id: form.getAttribute('id'),
                name: form.getAttribute('name'),
                inputs: inputs
            });
        });

        const reader = new Readability(doc);
        const article = reader.parse();

        const title = article?.title || doc.title || '';
        const description = article?.excerpt || '';
        const mainText = article?.textContent ? article.textContent.replace(/\s+/g, ' ').trim() : '';

        // Append images to content if they exist
        let enrichedContent = mainText;
        if (images.length > 0) {
            enrichedContent += '\n\n--- Images in Document ---\n' + 
                images.map(img => `[Image: ${img.title || 'No description'}] (${img.url})`).join('\n');
        }

        if (forms.length > 0) {
            enrichedContent += '\n\n--- Forms in Document ---\n' +
                forms.map(f => `[Form: ${f.name || f.id || 'Unnamed'} (${f.method} ${f.action})] Inputs: ${f.inputs.length}`).join('\n');
        }

        return {
            type: 'html',
            metadata: {
                title,
                description,
                image_count: images.length,
                form_count: forms.length,
                byline: article?.byline,
                siteName: article?.siteName,
                lang: article?.lang
            },
            content: enrichedContent,
            structured_data: {
                images,
                forms,
                readability: article ? {
                    length: article.length,
                    excerpt: article.excerpt
                } : undefined
            }
        };
    }

    private parseJson(content: string): NormalizedDocument {
         try {
            const parsed = JSON.parse(content);
            return {
                type: 'json',
                metadata: {},
                content: JSON.stringify(parsed, null, 2),
                structured_data: parsed
            }
         } catch(e) {
             return {
                 type: 'text',
                 metadata: { error: 'Invalid JSON'},
                 content: content
             }
         }
    }

    private async extractImageMeaning(buffer: Buffer, contentType: string, url?: string): Promise<NormalizedDocument> {
        const settings = settingsService.getInferenceSettings();
        const apiKey = settings.apiKey;
        
        // Ensure we have a sensible vision model default per provider if none set or if using OpenAI default on Gemini
        let visionModel = settings.visionModel;
        if (settings.provider === 'gemini') {
            if (!visionModel || visionModel === 'gpt-4o-mini') {
                visionModel = 'gemini-1.5-flash';
            }
        } else if (settings.provider === 'openai') {
            if (!visionModel || visionModel.includes('gemini')) {
                visionModel = 'gpt-4o-mini';
            }
        } else {
            // Local / Other
            visionModel = visionModel || 'gpt-4o-mini';
        }

        loggerService.info(`DocumentMeaningService: Starting vision analysis`, { 
            provider: settings.provider, 
            model: visionModel, 
            hasApiKey: !!apiKey,
            contentType,
            bufferSize: buffer.length
        });
        
        // If no API key or using local provider without vision support (simplification), fall back
        if (!apiKey && (settings.provider === 'openai' || settings.provider === 'gemini')) {
             loggerService.warn(`DocumentMeaningService: Missing API key for provider ${settings.provider}`);
             return {
                type: 'image',
                metadata: { url, error: "No API Key configured for vision model" },
                content: `[Image content cannot be analyzed: Missing API Key]`
            };
        }

        try {
            let description = "No description generated.";

            if (settings.provider === 'gemini') {
                const client = new GoogleGenerativeAI(apiKey);
                const model = client.getGenerativeModel({ model: visionModel });
                
                const imagePart = {
                    inlineData: {
                        data: buffer.toString('base64'),
                        mimeType: contentType || 'image/jpeg'
                    }
                };

                const result = await model.generateContent([
                    "Analyze this image. Describe the setting, identify key objects, and explain the relationships between them. Output a clear, structured description.",
                    imagePart
                ]);
                description = result.response.text();

            } else {
                // OpenAI / Local (OpenAI-compatible) logic
                let client: OpenAI;
                if (settings.provider === 'openai') {
                    client = new OpenAI({ apiKey });
                } else if (settings.provider === 'kimi2') {
                    client = new OpenAI({ 
                        baseURL: 'https://api.moonshot.ai/v1',
                        apiKey: apiKey 
                    });
                } else {
                     client = new OpenAI({ 
                         baseURL: settings.endpoint, 
                         apiKey: apiKey || 'lm-studio' 
                     });
                }
    
                const base64Image = buffer.toString('base64');
                const dataUrl = `data:${contentType || 'image/jpeg'};base64,${base64Image}`;
    
                const isO1 = visionModel.startsWith('o1') || visionModel.startsWith('o3') || visionModel.startsWith('gpt-5');
                
                const response = await client.chat.completions.create({
                    model: visionModel,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "Analyze this image. Describe the setting, identify key objects, and explain the relationships between them. Output a clear, structured description." },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: dataUrl
                                    }
                                }
                            ]
                        }
                    ],
                    ...(isO1 ? { max_completion_tokens: 2048 } : { max_tokens: 2048 })
                } as any);
                description = response.choices[0]?.message?.content || "No description generated.";
            }

            const cleanDescription = this.stripThinking(description);
            loggerService.info(`DocumentMeaningService: Vision analysis complete`, { 
                model: visionModel,
                metadata: { url, model: visionModel },
                descriptionLength: cleanDescription.length
            });
            
            const result: NormalizedDocument = {
                type: 'image',
                metadata: { url, model: visionModel },
                content: cleanDescription,
                structured_data: {
                    analysis_model: visionModel,
                    raw_response: cleanDescription
                }
            };

            loggerService.info(`DocumentMeaningService: Returning image document`, { 
                type: result.type,
                metadata: result.metadata,
                analysisResult: result.content
            });

            return result;

        } catch (error) {
            loggerService.error('DocumentMeaningService: Vision analysis failed', { error });
            return {
                type: 'image',
                metadata: { url, error: String(error) },
                content: `[Image analysis failed: ${String(error)}]`
            };
        }
    }

    private stripThinking(text: string): string {
        return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
}

export const documentMeaningService = new DocumentMeaningService();
