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

      console.log(`✅ Bot iniciado como ${this.session.uname}`);
      console.log(`Memory system: ${this.configService.get<boolean>('bot.useMemory') ? 'ENABLED' : 'DISABLED'}`);

      // Inicializar WebSocket
      this.socket = new WebSocket(socketUrl!);
      this.setupWebSocketHandlers();
      this.startResponseQueue();

    } catch (error) {
      console.error('❌ Error iniciando bot:', error);
      // Reintentar en 30 segundos
      setTimeout(() => this.startBot(), 30000);
    }
  }

  private setupWebSocketHandlers(): void {
    this.socket.on('open', () => {
      console.log('🔌 Conexión WebSocket abierta');
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

  private async handleMusicRequest(message: string, name: string, colorPrefix: string): Promise<void> {
    console.log(`🎵 Solicitud de música detectada de ${name}: "${message}"`);
    
    try {
      const query = MusicService.extractMusicQuery(message);
      console.log(`🔍 Query extraído: "${query}"`);
      
      if (!query || query.trim().length < 2) {
        const errorResponse = {
          message: `${colorPrefix}<@${name}> ❌ No pude entender qué música quieres. Intenta con: "!music nombre de la canción" o "reproduce [nombre de la canción]"`,
          username: this.session.uname,
          key: this.session.ukey,
          pic: this.session.pic,
          boxTag: this.session.boxTag,
          boxId: this.session.boxId,
          iframeUrl: this.session.iframeUrl,
        };
        await this.sendMessageWithSessionCheck(errorResponse);
        return;
      }

      // Enviar mensaje de confirmación
      const confirmationResponse = {
        message: `${colorPrefix}<@${name}> 🎵 Buscando y descargando "${query}"... Esto puede tomar unos momentos.`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };
      await this.sendMessageWithSessionCheck(confirmationResponse);

      console.log(`🎵 Iniciando procesamiento de música para ${name}...`);
      
      // Procesar música de forma asíncrona
      this.musicService.processMusic(query, name)
        .then(async (result) => {
          console.log(`✅ Música procesada exitosamente: ${result.substring(0, 100)}...`);
          const musicResponse = {
            message: `${colorPrefix}${result}`,
            username: this.session.uname,
            key: this.session.ukey,
            pic: this.session.pic,
            boxTag: this.session.boxTag,
            boxId: this.session.boxId,
            iframeUrl: this.session.iframeUrl,
          };
          
          // Esperar el RESPONSE_DELAY antes de enviar
          const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
          await this.utilsService.sleep(responseDelay);
          await this.sendMessageWithSessionCheck(musicResponse);
        })
        .catch(async (error) => {
          console.error(`❌ Error en procesamiento de música:`, error);
          const errorResponse = {
            message: `${colorPrefix}<@${name}> ❌ ${error.message}`,
            username: this.session.uname,
            key: this.session.ukey,
            pic: this.session.pic,
            boxTag: this.session.boxTag,
            boxId: this.session.boxId,
            iframeUrl: this.session.iframeUrl,
          };
          
          const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
          await this.utilsService.sleep(responseDelay);
          await this.sendMessageWithSessionCheck(errorResponse);
        });

      console.log(`🎵 Retornando sin procesar con GPT para mensaje: "${message}"`);
    } catch (error) {
      console.error(`❌ Error procesando solicitud de música:`, error);
      const errorResponse = {
        message: `${colorPrefix}<@${name}> ❌ Error interno procesando música. Intenta más tarde.`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };
      await this.sendMessageWithSessionCheck(errorResponse);
    }
  }

  private async handleChatResponse(response: string, name: string, colorPrefix: string): Promise<void> {
    // Dividir la respuesta usando nuestra función local
    const maxLength = this.configService.get<number>('bot.maxLengthResponse') || 200;
    const messageParts = this.utilsService.splitMessageIntoParts(response, maxLength);

    // Crear los datos base para el mensaje
    const baseMessageData = {
      username: this.session.uname,
      key: this.session.ukey,
      pic: this.session.pic,
      boxTag: this.session.boxTag,
      boxId: this.session.boxId,
      iframeUrl: this.session.iframeUrl,
    };

    // Crear las partes del mensaje con el formato correcto
    const messagesToSend = messageParts.map((part, index) => {
      let formattedMessage;
      if (index === 0) {
        // Primera parte con mención
        formattedMessage = `${colorPrefix}<@${name}> ${part}`;
      } else {
        // Partes siguientes sin mención
        formattedMessage = `${colorPrefix}${part}`;
      }
      
      return {
        ...baseMessageData,
        message: formattedMessage,
      };
    }).filter(msgData => {
      // Filtrar mensajes problemáticos antes de enviar
      const msg = msgData.message.trim();
      if (!msg || msg === colorPrefix || msg.match(/^[^#]*<@[^>]*>\s*$/)) {
        console.log('🚫 Mensaje problemático filtrado:', msg);
        return false;
      }
      return true;
    });

    const responseDelay = this.configService.get<number>('bot.responseDelay') || 20500;
    
    if (Date.now() - this.lastSentTime < responseDelay) {
      // Agregar todos los mensajes a la cola
      messagesToSend.forEach(msgData => {
        this.responseQueue.push(msgData);
      });
      return;
    }

    // Verificar si se solicitó resumen
    if (response.includes('{{resumen}}')) {
      await this.handleSummaryRequest(response, name, colorPrefix, maxLength);
      return;
    }

    // Verificar si se solicitó usuarios en línea
    if (response.includes('{{usuarios_online}}')) {
      await this.handleOnlineUsersFromGPT(response, name, colorPrefix);
      return;
    }

    // Enviar respuesta normal
    if (messagesToSend.length === 1) {
      // Mensaje único, enviar directamente
      await this.sendMessageWithSessionCheck(messagesToSend[0]);
    } else {
      // Mensajes múltiples, enviar con delay
      await this.sendMessageWithSessionCheck(messagesToSend[0]);
      
      // Enviar las partes restantes con delay
      for (let i = 1; i < messagesToSend.length; i++) {
        await this.utilsService.sleep(responseDelay);
        await this.sendMessageWithSessionCheck(messagesToSend[i]);
      }
    }
  }

  private async handleSummaryRequest(response: string, name: string, colorPrefix: string, maxLength: number): Promise<void> {
    const lastResumenEvent = await this.loggingService.getLastEventType('Resumen');

    // Verificar si ha pasado suficiente tiempo
    if (lastResumenEvent.minutesLeft < 10) {
      const responseData = {
        message: `${colorPrefix}<@${name}> Puedes leer el resumen anterior y esperar 10 minutos para poder generar uno nuevo. 🙂`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };
      await this.sendMessageWithSessionCheck(responseData);
      return;
    }

    // Enviar mensaje de confirmación primero (sin {{resumen}})
    const confirmationMessage = response.replace('{{resumen}}', '').trim();
    const confirmationData = {
      message: `${colorPrefix}<@${name}> ${confirmationMessage}`,
      username: this.session.uname,
      key: this.session.ukey,
      pic: this.session.pic,
      boxTag: this.session.boxTag,
      boxId: this.session.boxId,
      iframeUrl: this.session.iframeUrl,
    };
    await this.sendMessageWithSessionCheck(confirmationData);

    // Esperar un momento antes de empezar a generar el resumen
    const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
    await this.utilsService.sleep(responseDelay);

    // Generar y enviar el resumen
    try {
      console.log('📋 Generando resumen del chat...');
      const resumen = await this.chatService.generateSummary();
      
      // Dividir el resumen usando nuestra función local
      const resumenParts = this.utilsService.splitMessageIntoParts(resumen, maxLength);
      
      console.log(`📋 Enviando resumen en ${resumenParts.length} parte(s)`);
      
      // Enviar cada parte del resumen como mensaje independiente
      for (let i = 0; i < resumenParts.length; i++) {
        const part = resumenParts[i].trim();
        if (part) {
          // Formato mejorado para las partes del resumen
          const isFirstPart = i === 0;
          const isLastPart = i === resumenParts.length - 1;
          const partIndicator = resumenParts.length > 1 ? ` (${i + 1}/${resumenParts.length})` : '';
          
          let messagePrefix = '';
          if (isFirstPart) {
            messagePrefix = '📋✨ RESUMEN DEL CHAT' + partIndicator + '\n\n';
          } else {
            messagePrefix = `📋 RESUMEN${partIndicator}\n\n`;
          }
          
          let messageSuffix = '';
          if (isLastPart && resumenParts.length > 1) {
            messageSuffix = '\n\n¡Eso es todo por ahora! 🎬';
          }
          
          const responseData = {
            message: `${colorPrefix}${messagePrefix}${part}${messageSuffix}`,
            username: this.session.uname,
            key: this.session.ukey,
            pic: this.session.pic,
            boxTag: this.session.boxTag,
            boxId: this.session.boxId,
            iframeUrl: this.session.iframeUrl,
          };

          await this.sendMessageWithSessionCheck(responseData);
          
          // Esperar entre partes respetando el RESPONSE_DELAY del .env
          if (i < resumenParts.length - 1) {
            await this.utilsService.sleep(responseDelay);
          }
        }
      }
      
      // Guardar evento de resumen y limpiar log
      await this.loggingService.saveEventsLog('Resumen', name);
      const clearedCount = await this.loggingService.clearMessagesLog();
      console.log(`✅ Resumen completado y log limpiado (${clearedCount} mensajes eliminados)`);
      
    } catch (error) {
      console.error('❌ Error generating summary:', error);
      const errorData = {
        message: `${colorPrefix}❌ Error al generar el resumen. Inténtalo más tarde.`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };
      await this.sendMessageWithSessionCheck(errorData);
    }
  }

  private startResponseQueue(): void {
    setInterval(() => {
      const responseDelay = this.configService.get<number>('bot.responseDelay') || 20500;
      
      if (
        this.responseQueue.length > 0 &&
        Date.now() - this.lastSentTime > responseDelay
      ) {
        const response = this.responseQueue.shift();
        this.sendMessageWithSessionCheck(response);
        
        // Si hay más respuestas en la cola del mismo tipo (partes múltiples), 
        // procesarlas con un delay menor
        if (this.responseQueue.length > 0) {
          setTimeout(async () => {
            const nextResponse = this.responseQueue.shift();
            if (nextResponse) {
              await this.sendMessageWithSessionCheck(nextResponse);
            }
          }, responseDelay); // Usar RESPONSE_DELAY para partes adicionales
        }
      }
    }, 1000);
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
          console.error('❌ Error al renovar sesión:', loginData.error);
          return false;
        }
        
        const { nme, key, pic } = loginData.udata;
        
        // Actualizar datos de sesión
        this.session.uname = nme || this.configService.get<string>('cbox.username')!;
        this.session.ukey = key!;
        this.session.pic = this.configService.get<string>('cbox.defaultPic') || pic || '';
        this.session.lastLoginTime = currentTime;
        
        console.log(`✅ Sesión renovada exitosamente para ${this.session.uname}`);
        return true;
      } catch (error) {
        console.error('❌ Error inesperado al renovar sesión:', error);
        return false;
      }
    }
    
    return true; // No necesita renovación
  }

  // Método auxiliar para enviar mensaje con renovación de sesión automática
  private async sendMessageWithSessionCheck(messageData: any): Promise<boolean> {
    // Validar el mensaje antes de enviar
    if (!this.isValidMessage(messageData.message)) {
      console.log('🚫 Mensaje inválido no enviado:', messageData.message);
      return false;
    }

    // Verificar y renovar sesión si es necesario
    const sessionValid = await this.renewSessionIfNeeded();
    if (!sessionValid) {
      console.error('❌ No se pudo renovar la sesión, mensaje no enviado');
      return false;
    }
    
    // Actualizar datos del mensaje con la sesión actual
    const updatedMessageData = {
      ...messageData,
      key: this.session.ukey,
      username: this.session.uname,
      pic: this.session.pic,
    };
    
    try {
      await this.messagesService.sendMessage(updatedMessageData);
      this.lastSentTime = Date.now();
      return true;
    } catch (error) {
      console.error('❌ Error al enviar mensaje:', error);
      return false;
    }
  }

  // Método para validar que un mensaje es válido antes de enviarlo
  private isValidMessage(message: string): boolean {
    if (!message || message.trim().length === 0) {
      return false;
    }

    const cleanMessage = message.trim();
    
    // Filtrar mensajes que solo contengan menciones incompletas
    if (cleanMessage === '<@' || cleanMessage.match(/^<@\s*>?$/)) {
      return false;
    }

    // Filtrar mensajes que solo contengan menciones vacías (con o sin color)
    if (cleanMessage.match(/^(\^#[a-fA-F0-9]+\s*)?<@[^>]*>\s*$/)) {
      return false;
    }

    // Filtrar mensajes que solo contengan prefijo de color sin contenido
    if (cleanMessage.match(/^\^#[a-fA-F0-9]+\s*$/)) {
      return false;
    }

    return true;
  }

  /**
   * Detecta si un mensaje es una solicitud de usuarios en línea
   */
  private isOnlineUsersRequest(message: string): boolean {
    if (!message || typeof message !== "string") {
      return false;
    }

    const lowerMessage = message.toLowerCase();

    const onlineKeywords = [
      'quién está en línea',
      'quien esta en linea',
      'quienes están en línea',
      'quienes estan en linea',
      'usuarios en línea',
      'usuarios en linea',
      'lista de usuarios',
      'who is online',
      'online users',
      'users online',
      'gente en línea',
      'gente en linea',
      'cuántos están en línea',
      'cuantos estan en linea',
      'cuántos online',
      'cuantos online',
      'lista online',
      'ver usuarios',
      'usuarios conectados',
      'conectados',
      'en línea',
      'en linea',
      'online'
    ];

    return onlineKeywords.some(keyword => lowerMessage.includes(keyword));
  }

  /**
   * Maneja las solicitudes de usuarios en línea
   */
  private async handleOnlineUsersRequest(message: string, name: string, colorPrefix: string): Promise<void> {
    console.log(`👥 Solicitud de usuarios en línea detectada de ${name}: "${message}"`);
    
    try {
      // Obtener usuarios en línea
      const onlineData = await this.onlineUsersService.getOnlineUsers(
        this.session.boxId,
        this.session.boxTag
      );

      // Generar resumen
      const summary = this.onlineUsersService.generateOnlineUsersSummary(onlineData);
      
      // Enviar respuesta
      const response = {
        message: `${colorPrefix}<@${name}> ${summary}`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };

      await this.sendMessageWithSessionCheck(response);
      
      console.log(`✅ Lista de usuarios en línea enviada a ${name}`);
    } catch (error) {
      console.error(`❌ Error obteniendo usuarios en línea:`, error);
      const errorResponse = {
        message: `${colorPrefix}<@${name}> ❌ Error obteniendo la lista de usuarios en línea. Intenta más tarde.`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };
      await this.sendMessageWithSessionCheck(errorResponse);
    }
  }

  /**
   * Maneja las solicitudes de usuarios en línea cuando vienen de ChatGPT
   */
  private async handleOnlineUsersFromGPT(response: string, name: string, colorPrefix: string): Promise<void> {
    try {
      // Enviar mensaje de confirmación primero (sin {{usuarios_online}})
      const confirmationMessage = response.replace('{{usuarios_online}}', '').trim();
      if (confirmationMessage) {
        const confirmationData = {
          message: `${colorPrefix}<@${name}> ${confirmationMessage}`,
          username: this.session.uname,
          key: this.session.ukey,
          pic: this.session.pic,
          boxTag: this.session.boxTag,
          boxId: this.session.boxId,
          iframeUrl: this.session.iframeUrl,
        };
        await this.sendMessageWithSessionCheck(confirmationData);
        
        // Esperar un momento antes de mostrar la lista
        const responseDelay = this.configService.get<number>('bot.responseDelay') || 1000;
        await this.utilsService.sleep(responseDelay);
      }

      // Obtener y enviar usuarios en línea
      console.log(`👥 [GPT] Solicitud de usuarios en línea interpretada por ChatGPT de ${name}`);
      
      const onlineData = await this.onlineUsersService.getOnlineUsers(
        this.session.boxId,
        this.session.boxTag
      );

      const summary = this.onlineUsersService.generateOnlineUsersSummary(onlineData);
      
      const onlineResponse = {
        message: `${colorPrefix}${summary}`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };

      await this.sendMessageWithSessionCheck(onlineResponse);
      console.log(`✅ [GPT] Lista de usuarios en línea enviada a ${name} (interpretado por ChatGPT)`);
      
    } catch (error) {
      console.error(`❌ [GPT] Error obteniendo usuarios en línea:`, error);
      const errorResponse = {
        message: `${colorPrefix}❌ Error obteniendo la lista de usuarios en línea. Intenta más tarde.`,
        username: this.session.uname,
        key: this.session.ukey,
        pic: this.session.pic,
        boxTag: this.session.boxTag,
        boxId: this.session.boxId,
        iframeUrl: this.session.iframeUrl,
      };
      await this.sendMessageWithSessionCheck(errorResponse);
    }
  }
}