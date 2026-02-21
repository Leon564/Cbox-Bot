import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as FormData from 'form-data';

@Injectable()
export class ImageService {
  private openai: OpenAI;
  private isProcessing: boolean = false;
  private queue: Array<{
    prompt: string;
    username: string;
    resolve: (result: string) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly configService: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.configService.get<string>('openai.apiKey'),
    });
  }

  /**
   * Detecta si un mensaje es una solicitud de generación de imagen
   */
  static isImageRequest(message: string): boolean {
    if (!message || typeof message !== 'string') return false;

    const lower = message.toLowerCase();

    // Comando directo
    if (lower.match(/^!image\s+.+/i) || lower.match(/^!img\s+.+/i)) return true;

    // Frases naturales en español e inglés
    const keywords = [
      'genera una imagen',
      'genera imagen',
      'crea una imagen',
      'crea imagen',
      'dibuja',
      'ilustra',
      'muéstrame una imagen',
      'muestrame una imagen',
      'hazme una imagen',
      'quiero una imagen',
      'quiero ver',
      'generate an image',
      'generate image',
      'create an image',
      'draw me',
      'show me an image',
      'make an image',
    ];

    return keywords.some((kw) => lower.includes(kw));
  }

  /**
   * Extrae el prompt de generación del mensaje del usuario
   */
  static extractImagePrompt(message: string): string {
    if (!message || typeof message !== 'string') return '';

    // Comando directo !image / !img
    const cmdMatch = message.match(/^!(?:image|img)\s+(.+)/i);
    if (cmdMatch) return cmdMatch[1].trim();

    // Patrones naturales (orden de más específico a menos)
    const patterns = [
      /genera(?:\s+una)?\s+imagen\s+(?:de\s+)?["']?(.+?)["']?$/i,
      /crea(?:\s+una)?\s+imagen\s+(?:de\s+)?["']?(.+?)["']?$/i,
      /dibuja(?:\s+me)?\s+["']?(.+?)["']?$/i,
      /ilustra(?:\s+me)?\s+["']?(.+?)["']?$/i,
      /muéstrame\s+una\s+imagen\s+(?:de\s+)?["']?(.+?)["']?$/i,
      /muestrame\s+una\s+imagen\s+(?:de\s+)?["']?(.+?)["']?$/i,
      /hazme\s+una\s+imagen\s+(?:de\s+)?["']?(.+?)["']?$/i,
      /quiero(?:\s+una)?\s+imagen\s+(?:de\s+)?["']?(.+?)["']?$/i,
      /quiero\s+ver\s+["']?(.+?)["']?$/i,
      /generate\s+(?:an?\s+)?image\s+(?:of\s+)?["']?(.+?)["']?$/i,
      /create\s+(?:an?\s+)?image\s+(?:of\s+)?["']?(.+?)["']?$/i,
      /draw\s+me\s+["']?(.+?)["']?$/i,
      /show\s+me\s+(?:an?\s+)?image\s+(?:of\s+)?["']?(.+?)["']?$/i,
      /make\s+(?:an?\s+)?image\s+(?:of\s+)?["']?(.+?)["']?$/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return '';
  }

  /**
   * Encola una solicitud de imagen y devuelve la promesa
   */
  async generateImage(prompt: string, username: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, username, resolve, reject });
      console.log(
        `🎨 [IMAGE QUEUE] Solicitud añadida. Total en cola: ${this.queue.length}`,
      );
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * Procesa la cola de generación de imágenes
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    console.log(
      `🎨 [IMAGE QUEUE] Iniciando procesamiento. ${this.queue.length} elemento(s) pendiente(s)`,
    );

    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      try {
        console.log(
          `🎨 [IMAGE] Procesando imagen para ${request.username}: "${request.prompt}"`,
        );
        const result = await this.processSingleImageRequest(
          request.prompt,
          request.username,
        );
        request.resolve(result);
      } catch (error) {
        console.error(
          `🎨 [IMAGE ERROR] Error procesando "${request.prompt}":`,
          error,
        );
        request.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      // Delay de 5 segundos entre cada elemento de la cola
      if (this.queue.length > 0) {
        console.log(
          `⏱️ [IMAGE QUEUE] Esperando 5 segundos antes del siguiente elemento...`,
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    this.isProcessing = false;
    console.log(`🎨 [IMAGE QUEUE] Cola completada`);
  }

  /**
   * Genera la imagen, la descarga y la sube a Catbox
   */
  private async processSingleImageRequest(
    prompt: string,
    username: string,
  ): Promise<string> {
    const size =
      (this.configService.get<string>('image.size') as
        | '1024x1024'
        | '1792x1024'
        | '1024x1792') || '1024x1024';
    const model =
      this.configService.get<string>('image.model') || 'dall-e-3';
    const quality =
      (this.configService.get<string>('image.quality') as
        | 'standard'
        | 'hd') || 'standard';

    console.log(
      `🖼️ [DALL-E] Generando imagen con ${model} — tamaño: ${size}, calidad: ${quality}`,
    );
    console.log(`🖼️ [DALL-E] Prompt: "${prompt}"`);

    // 1. Llamar a la API de OpenAI
    const response = await this.openai.images.generate({
      model,
      prompt,
      n: 1,
      size,
      quality,
      response_format: 'url',
    });

    const imageUrl = response.data[0]?.url;
    if (!imageUrl) {
      throw new Error('OpenAI no devolvió una URL de imagen válida');
    }

    console.log(`✅ [DALL-E] Imagen generada: ${imageUrl.substring(0, 80)}...`);

    // 2. Descargar la imagen
    const imageBuffer = await this.downloadImage(imageUrl);
    console.log(
      `📦 [IMAGE] Imagen descargada: ${(imageBuffer.length / 1024).toFixed(1)} KB`,
    );

    // 3. Guardar temporalmente
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const sanitized = username.replace(/[^\w\-_.]/g, '').substring(0, 20) || 'user';
    const filename = `image_${Date.now()}_${sanitized}.png`;
    const tempPath = path.join(tempDir, filename);
    fs.writeFileSync(tempPath, imageBuffer);

    // 4. Subir a Catbox
    const catboxUrl = await this.uploadToCatbox(tempPath, filename);
    console.log(`☁️ [CATBOX] Imagen subida: ${catboxUrl}`);

    // 5. Limpiar temporal
    fs.unlinkSync(tempPath);

    return `🎨 <@${username}> Aquí está tu imagen: [img]${catboxUrl}[/img]`;
  }

  /**
   * Descarga el binario de una URL
   */
  private async downloadImage(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Error descargando imagen: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Sube un archivo PNG a Catbox y devuelve la URL pública
   */
  private async uploadToCatbox(
    filePath: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('userhash', '');
    form.append('fileToUpload', fs.createReadStream(filePath), {
      filename,
      contentType: 'image/png',
    });

    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: form as any,
    });

    if (!res.ok) {
      throw new Error(`Error subiendo a Catbox: HTTP ${res.status}`);
    }

    const catboxUrl = await res.text();

    if (!catboxUrl.startsWith('https://')) {
      throw new Error(`Respuesta inesperada de Catbox: ${catboxUrl}`);
    }

    return catboxUrl.trim();
  }

  /**
   * Estado de la cola (para debug)
   */
  getQueueStatus(): { isProcessing: boolean; queueLength: number } {
    return {
      isProcessing: this.isProcessing,
      queueLength: this.queue.length,
    };
  }
}
