import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as WebSocket from 'ws';
import { AuthService } from '../auth/auth.service';
import { MessagesService } from '../chat/messages.service';
import { ModerationService } from '../chat/moderation.service';
import { LoggingService } from '../../common/utils/logging.service';
import { BotSession } from '../../common/interfaces';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private session!: BotSession;
  private socket!: WebSocket;
  private readonly SESSION_DURATION = 15 * 60 * 1000; // 15 minutos en milisegundos
  private warningMessages: Set<string> = new Set(); // Para rastrear IDs de mensajes de advertencia

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly messagesService: MessagesService,
    private readonly moderationService: ModerationService,
    private readonly loggingService: LoggingService,
  ) {}

  async onModuleInit() {
    console.log('🛡️ Inicializando Moderador Bot Service...');
    await this.startBot();
  }

  onModuleDestroy() {
    if (this.socket) {
      this.socket.close();
    }
  }

  private async startBot(): Promise<void> {
    try {
      const cboxUrl = this.configService.get<string>('cbox.url');
      if (!cboxUrl) {
        throw new Error('CBOX_URL no está configurado');
      }

      const { boxId, boxTag, iframeUrl, socketUrl } = await this.authService.getBoxDetails(cboxUrl);
      
      const loginData = await this.authService.login({
        boxId: boxId!,
        boxTag: boxTag!,
        iframeUrl: iframeUrl!,
        password: this.configService.get<string>('cbox.password')!,
        username: this.configService.get<string>('cbox.username')!,
      });

      if (loginData.error) {
        console.error('❌ Error al iniciar sesión:', loginData.error);
        return;
      }

      const { nme, key, pic } = loginData.udata;
      
      // Establecer sesión
      this.session = {
        uname: nme || this.configService.get<string>('cbox.username')!,
        ukey: key!,
        pic: this.configService.get<string>('cbox.defaultPic') || pic || '',
        boxId: boxId!,
        boxTag: boxTag!,
        iframeUrl: iframeUrl!,
        lastLoginTime: Date.now(),
      };

      console.log(`✅ Bot moderador iniciado como ${this.session.uname}`);
      console.log(`🛡️ Moderación automática: ${this.configService.get<boolean>('bot.autoModerateAll') ? 'ENABLED' : 'DISABLED'}`);
      console.log(`🗑️ Eliminación automática: ${this.configService.get<boolean>('bot.autoDeleteMessages') ? 'ENABLED' : 'DISABLED'}`);
      console.log(`⚠️ Advertencias públicas: ${this.configService.get<boolean>('bot.sendModerationWarnings') !== false ? 'ENABLED' : 'DISABLED'}`);

      // Inicializar WebSocket
      this.socket = new WebSocket(socketUrl!);
      this.setupWebSocketHandlers();

    } catch (error) {
      console.error('❌ Error iniciando bot moderador:', error);
      // Reintentar en 30 segundos
      setTimeout(() => this.startBot(), 30000);
    }
  }

  private setupWebSocketHandlers(): void {
    this.socket.on('open', () => {
      console.log('🔌 Conexión WebSocket abierta - Moderador activo');
    });

    this.socket.on('message', async (data: WebSocket.Data) => {
      try {
        await this.handleMessage(data);
      } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
      }
    });

    this.socket.on('error', (error: Error) => {
      console.error('❌ Error de conexión WebSocket:', error.message);
      setTimeout(() => this.startBot(), 5000);
    });

    this.socket.on('close', (code: number, reason: string) => {
      console.log('🔌 Conexión WebSocket cerrada:', code, reason);
      setTimeout(() => this.startBot(), 5000);
    });
  }

  private async handleMessage(data: WebSocket.Data): Promise<void> {
    const { date, id, lvl, message, name } = this.messagesService.toDomain(data);

    // Debug: mostrar nombre limpio vs nombre del bot
    console.log(`🔍 Comparando nombres: "${name}" vs "${this.session.uname}"`);

    // CRÍTICO: No procesar mensajes del propio bot
    if (name === this.session.uname) {
      console.log(`🚫 Mensaje del bot excluido del procesamiento: "${message?.substring(0, 50)}${message && message.length > 50 ? '...' : ''}"`);
      
      // Detectar si es un mensaje de advertencia y programar su eliminación
      if (message && message.includes('🔇') && message.includes('Mensaje eliminado por')) {
        this.scheduleWarningDeletion(id);
      }
      
      return;
    }

    // Solo guardar el log del mensaje
    if (name && message) {
      await this.loggingService.saveLog(name, message);
    }

    // MODERACIÓN AUTOMÁTICA - Procesar TODOS los mensajes
    const autoModerateAll = this.configService.get<boolean>('bot.autoModerateAll');
    if (autoModerateAll && name && message) {
      console.log(`🛡️ [AUTO-MOD] Moderando mensaje de ${name}...`);
      
      try {
        const moderationResult = await this.moderationService.moderateMessage(
          message, 
          name, 
          parseInt(lvl?.toString() || '1', 10)
        );

        if (!moderationResult.isAllowed) {
          console.log(`🚫 [MOD] Mensaje bloqueado de ${name}: ${moderationResult.reason}`);
          
          // Crear función de eliminación para pasar al servicio de moderación
          const deleteMessageFunction = async (messageId: string): Promise<boolean> => {
            return await this.messagesService.deleteMessage({
              key: this.session.ukey,
              messageId: messageId,
              username: this.session.uname,
              boxId: this.session.boxId,
              boxTag: this.session.boxTag,
              iframeUrl: this.session.iframeUrl,
            });
          };
          
          // Ejecutar acción de moderación (enviar advertencia y/o eliminar mensaje si es necesario)
          const warningMessage = await this.moderationService.executeModeration(
            moderationResult, 
            name, 
            id,
            deleteMessageFunction
          );
          
          // Enviar advertencia solo si está configurado
          const sendWarnings = this.configService.get<boolean>('bot.sendModerationWarnings') ?? true;
          if (warningMessage && sendWarnings) {
            const textColor = this.configService.get<string>('bot.textColor');
            const colorPrefix = textColor ? `^#${textColor} ` : '';
            
            await this.sendMessageWithSessionCheck({
              message: `${colorPrefix}${warningMessage}`,
              username: this.session.uname,
              key: this.session.ukey,
              pic: this.session.pic,
              boxTag: this.session.boxTag,
              boxId: this.session.boxId,
              iframeUrl: this.session.iframeUrl,
            });
          }
          
          // IMPORTANTE: Terminar procesamiento aquí para mensajes bloqueados
          return;
        }
        
        console.log(`✅ [MOD] Mensaje aprobado de ${name}`);
      } catch (error) {
        console.error('❌ [MOD] Error en moderación automática:', error);
      }
    }
  }

  // Método para renovar la sesión cuando sea necesario
  private async renewSessionIfNeeded(): Promise<boolean> {
    const currentTime = Date.now();
    const timeSinceLastLogin = currentTime - this.session.lastLoginTime;

    // Si ha pasado más de 15 minutos desde el último login, renovar la sesión
    if (timeSinceLastLogin > this.SESSION_DURATION) {
      console.log(`🔄 Renovando sesión... (${Math.round(timeSinceLastLogin / (60 * 1000))} minutos desde último login)`);
      
      try {
        const loginData = await this.authService.login({
          boxId: this.session.boxId,
          boxTag: this.session.boxTag,
          iframeUrl: this.session.iframeUrl,
          password: this.configService.get<string>('cbox.password')!,
          username: this.configService.get<string>('cbox.username')!,
        });
        
        if (loginData.error) {
          console.error('❌ Error renovando sesión:', loginData.error);
          return false;
        }
        
        // Actualizar session con nueva información
        const { nme, key, pic } = loginData.udata;
        this.session.ukey = key!;
        this.session.pic = pic || this.session.pic;
        this.session.lastLoginTime = currentTime;
        
        console.log(`✅ Sesión renovada exitosamente para ${nme}`);
        return true;
        
      } catch (error) {
        console.error('❌ Error en renovación de sesión:', error);
        return false;
      }
    }
    
    return true; // No necesita renovación
  }

  /**
   * Programa la eliminación de un mensaje de advertencia después de 10 segundos
   */
  private scheduleWarningDeletion(messageId: string): void {
    console.log(`⏰ Programando eliminación de advertencia ${messageId} en 10 segundos...`);
    
    setTimeout(async () => {
      try {
        await this.deleteMessage(messageId);
        console.log(`✅ Mensaje de advertencia ${messageId} eliminado automáticamente`);
      } catch (error) {
        console.error(`❌ Error eliminando mensaje de advertencia ${messageId}:`, error);
      }
    }, 10000); // 10 segundos
  }

  /**
   * Elimina un mensaje específico del chat
   */
  private async deleteMessage(messageId: string): Promise<void> {
    try {
      const sessionValid = await this.renewSessionIfNeeded();
      if (!sessionValid) {
        console.error('❌ No se pudo renovar la sesión para eliminar mensaje');
        return;
      }

      const baseUrl = this.session.iframeUrl?.split('?')[0];
      const deleteUrl = `${baseUrl}?sec=delban&boxid=${this.session.boxId}&boxtag=${this.session.boxTag}&_v=1063&n=${this.session.uname}&k=${this.session.ukey}&del=${messageId}`;
      
      console.log(`🗑️ [AUTO-DELETE] Eliminando advertencia ID: ${messageId}`);
      
      const response = await fetch(deleteUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const result = await response.text();
      console.log(`🗑️ [AUTO-DELETE] Respuesta: ${result}`);
      
      if (result.includes('OK') || result.includes('success')) {
        console.log(`✅ [AUTO-DELETE] Advertencia ${messageId} eliminada exitosamente`);
      } else {
        console.log(`⚠️ [AUTO-DELETE] Respuesta inesperada para ${messageId}: ${result}`);
      }
    } catch (error) {
      console.error(`❌ Error eliminando advertencia ${messageId}:`, error);
    }
  }

  private async sendMessageWithSessionCheck(messageData: any): Promise<void> {
    try {
      // Verificar si la sesión necesita renovación antes de enviar mensaje
      const sessionValid = await this.renewSessionIfNeeded();
      if (!sessionValid) {
        console.error('❌ No se pudo renovar la sesión, no se enviará el mensaje');
        return;
      }

      console.log(`📤 [Enviando advertencia]: ${messageData.message}`);
      
      const response = await this.messagesService.sendMessage(messageData);
      console.log(`✅ Advertencia de moderación enviada exitosamente`);
    } catch (error) {
      console.error(`❌ Error enviando advertencia de moderación:`, error);
      
      // En caso de error, intentar renovar sesión para el próximo mensaje
      await this.renewSessionIfNeeded();
    }
  }

  // Cron job para renovar sesión automáticamente cada 10 minutos
  @Cron(CronExpression.EVERY_10_MINUTES)
  private async autoRenewSession(): Promise<void> {
    console.log('🔄 Ejecutando renovación automática de sesión...');
    await this.renewSessionIfNeeded();
  }
}